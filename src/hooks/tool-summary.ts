/**
 * Shape a Claude Code PostToolUse `tool_input` into a short, non-sensitive
 * string suitable for on-disk storage and LLM-prompt interpolation.
 *
 * Threat model: `tool_input` is attacker-controlled context. The raw shape
 * includes `Bash.command`, `Edit.old_string` / `new_string`, `Write.content`,
 * `WebFetch.url` — all places secrets routinely live (API keys, tokens,
 * Bearer auth, source text). Those values flow downstream in two places:
 * `last_tool_summary` is written to `~/.idle/state.json` and archived at
 * SessionEnd; it is also interpolated into the Stop hook's `claude -p`
 * prompt. Blindly `JSON.stringify(input).slice(0, 200)` leaks secrets to
 * disk and into later model context.
 *
 * This module makes two commitments to fix that:
 *
 * 1. **Allowlist extraction, not key filtering.** For known tools, we pull
 *    only fields that describe WHAT was done — program name, file path,
 *    pattern, subagent type — never command args, file content, edit
 *    strings, or URLs. For unknown tools, we return the sorted top-level
 *    key list and no values at all.
 * 2. **Defense-in-depth secret redaction.** A final pass scrubs common
 *    secret shapes (OpenAI `sk-*`, AWS access keys, GitHub tokens,
 *    Slack tokens, Google API keys, Bearer auth, generic `KEY=value`
 *    shell-style assignments) from whatever the extractor produced. This
 *    catches secrets that slip through a user's path or pattern.
 *
 * The final string is pre-sliced to 400 chars; the state helper applies
 * the canonical 200-char cap when writing.
 */

/** A tool_input value is summarizable only when it is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  return typeof v === 'string' ? v : '';
}

/**
 * Return the first token of a shell command that is not a `KEY=value`
 * env-var assignment. `PASSWORD=foo myprog` → `"myprog"`, so inline
 * secret env vars are dropped before being written to disk.
 */
function firstBashToken(command: string): string {
  const tokens = command.trim().split(/\s+/);
  for (const t of tokens) {
    if (t.length === 0) continue;
    if (/^[A-Z_][A-Z0-9_]*=/.test(t)) continue;
    return t;
  }
  return '';
}

/**
 * Per-tool allowlist extractors. Each returns a short descriptor with no
 * secret-bearing values. Tools not in this map fall through to the
 * keys-only default.
 */
const EXTRACTORS: Readonly<
  Record<string, (input: Record<string, unknown>) => string>
> = {
  Bash: (i) => {
    const cmd = firstBashToken(stringField(i, 'command'));
    return cmd ? `$ ${cmd}` : '';
  },
  Read: (i) => stringField(i, 'file_path'),
  Write: (i) => stringField(i, 'file_path'),
  Edit: (i) => stringField(i, 'file_path'),
  MultiEdit: (i) => stringField(i, 'file_path'),
  NotebookEdit: (i) => stringField(i, 'notebook_path'),
  NotebookRead: (i) => stringField(i, 'notebook_path'),
  Glob: (i) => stringField(i, 'pattern'),
  Grep: (i) => stringField(i, 'pattern'),
  Task: (i) => {
    const t = stringField(i, 'subagent_type');
    return t ? `agent:${t}` : 'agent';
  },
  Agent: (i) => {
    const t = stringField(i, 'subagent_type');
    return t ? `agent:${t}` : 'agent';
  },
  TodoWrite: (i) =>
    Array.isArray(i.todos) ? `todos:${i.todos.length}` : 'todos',
  WebFetch: () => '',
  WebSearch: () => '',
  ToolSearch: () => '',
};

/**
 * Regexes for widely-deployed secret shapes. Each requires enough prefix
 * plus enough entropy to avoid matching normal text. Matches are replaced
 * with the literal `<redacted>` so a reviewer browsing the archive can
 * see that a value was scrubbed, not that it was simply absent.
 *
 * The generic `KEY=VALUE` rule only fires when the key is
 * `UPPER_SNAKE_CASE` and the value is non-empty; this is conservative on
 * purpose — `name=bob` or `type=http` should not get redacted.
 */
const SECRET_PATTERNS: readonly { re: RegExp; replace: string }[] = [
  { re: /sk-proj-[A-Za-z0-9_-]{20,}/g, replace: '<redacted>' },
  { re: /sk-[A-Za-z0-9_-]{20,}/g, replace: '<redacted>' },
  { re: /AKIA[0-9A-Z]{16}/g, replace: '<redacted>' },
  { re: /ASIA[0-9A-Z]{16}/g, replace: '<redacted>' },
  { re: /gh[pousr]_[A-Za-z0-9]{20,}/g, replace: '<redacted>' },
  { re: /glpat-[A-Za-z0-9_-]{10,}/g, replace: '<redacted>' },
  { re: /xox[abpr]-[A-Za-z0-9-]{10,}/g, replace: '<redacted>' },
  { re: /AIza[0-9A-Za-z_-]{35}/g, replace: '<redacted>' },
  {
    re: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi,
    replace: 'Bearer <redacted>',
  },
  // Shell-style env-var assignments: FOO_KEY=something (value redacted).
  // Variable name = optional SHOUTY prefix + sensitive suffix keyword,
  // e.g. "PASSWORD", "API_TOKEN", "SESSION_COOKIE", "MY_DB_SECRET".
  {
    re: /\b((?:[A-Z][A-Z0-9_]*)?(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|AUTH|SESSION|COOKIE))=[^\s'"`&|;]+/g,
    replace: '$1=<redacted>',
  },
];

/** Apply every secret-pattern redaction to `s`. Input is returned intact
 * if no pattern matches. */
export function redactSecrets(s: string): string {
  let out = s;
  for (const { re, replace } of SECRET_PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}

/**
 * Produce a short summary of a PostToolUse `tool_input`. Safe to persist
 * and to interpolate into an LLM prompt — extractor is an allowlist,
 * followed by a secret-pattern sweep. Returns `''` when the input cannot
 * be safely summarized.
 *
 * The 200-char canonical cap is enforced downstream by
 * `incrementToolCounter`; we pre-slice to 400 to avoid shuttling very
 * large strings across a sync lock.
 */
export function summarizeToolInput(
  toolName: string,
  value: unknown,
): string {
  if (!isRecord(value)) return '';

  const extractor = EXTRACTORS[toolName];
  const raw = extractor
    ? extractor(value)
    : `keys:${Object.keys(value).sort().join(',')}`;

  const redacted = redactSecrets(raw);
  return redacted.length > 400 ? redacted.slice(0, 400) : redacted;
}
