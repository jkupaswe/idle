/**
 * Secret-shape redaction for strings that will be persisted or interpolated
 * into later LLM context.
 *
 * Two layers call this:
 *
 * 1. **Hook layer** (`src/hooks/tool-summary.ts`) runs it as the final pass
 *    after allowlist extraction, so a secret that slips through a file
 *    path or pattern never reaches disk.
 * 2. **Core layer** (`src/core/state.ts`) runs it again inside
 *    `incrementToolCounter` right before stashing `last_tool_name` and
 *    `last_tool_summary` into the session entry. This is defense-in-depth:
 *    any future caller that bypasses the Hook sanitizer (test harnesses,
 *    internal tools, later hook scripts) still cannot persist an
 *    unredacted secret.
 *
 * Redaction is conservative on purpose — each pattern requires enough
 * prefix plus enough entropy to avoid matching normal text. Matches are
 * replaced with the literal `<redacted>` so a reviewer browsing the
 * archive can see that a value was scrubbed, not that it was simply
 * absent. The generic `KEY=VALUE` rule only fires when the key is
 * UPPER_SNAKE_CASE and ends in a sensitive suffix (`KEY`, `TOKEN`,
 * `SECRET`, `PASSWORD`, `PASS`, `PASSWD`, `AUTH`, `SESSION`, `COOKIE`),
 * so `name=bob` or `type=http` pass through untouched.
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

/**
 * Replace every recognized secret shape in `s` with `<redacted>`. Already-
 * redacted input is a fixed point: running `redactSecrets` twice yields the
 * same string, so the Hook-then-Core double-pass is safe.
 */
export function redactSecrets(s: string): string {
  let out = s;
  for (const { re, replace } of SECRET_PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}
