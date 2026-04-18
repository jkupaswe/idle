# T-010 — Stop hook design doc

Fires when the agent finishes responding. If a check-in is pending, generates a one-sentence break suggestion via `claude -p` and triggers a native notification. Composes five shipped primitives: `consumePendingCheckin`, `loadConfig`, the four tone-preset `buildPrompt` functions, a new `invokeClaudeP` helper, and `notify`.

Design phase only; no `src/hooks/stop.ts` or tests in this PR.

## 1. Proposed types

No new on-disk types. Every payload, state, and stats shape already exists.

Reused, imported as-is:

- `StopPayload` (`src/lib/types.ts`) — `session_id`, `transcript_path`, `cwd`, `hook_event_name: 'Stop'`, `stop_hook_active?`, `last_assistant_message?`.
- `SessionEntry` — fields returned inside the `consumePendingCheckin` success snapshot. Pre-reset values; counters reflect what tripped the threshold.
- `CheckInStats` — `{ duration_minutes, tool_calls, last_tool_name?, last_tool_summary? }`.
- `TonePreset` — `'dry' | 'earnest' | 'absurdist' | 'silent'`.
- `SessionId` + `isSessionId` — brand guard.

Two new *internal* types, scoped to `src/hooks/stop.ts`:

```ts
type TemplateBuilder = (stats: CheckInStats) => string;

type ClaudeResult =
  | { ok: true; output: string }
  | { ok: false; reason: 'timeout' | 'enoent' | 'nonzero' | 'killed' };
```

`TemplateBuilder` keys a tone→builder dispatch table so callers do not hand-dispatch on the union. `ClaudeResult` is the testable seam — tests mock `invokeClaudeP` rather than the underlying `execFile`.

## 2. Child process invocation

`execFile('claude', ['-p', prompt], options)` via `util.promisify` — same pattern as `src/core/notify.ts`. Not `spawn`. Not `exec`. `execFile` passes the prompt as a single argv entry with no shell interpretation; LLM-generated content cannot inject backticks, `$()`, or `;` to escape into a shell.

Options:

```ts
{
  env: process.env,
  timeout: 8_000,
  maxBuffer: 64 * 1024,
  windowsHide: true,
  // killSignal: default (SIGTERM)
}
```

### Deviation from TASKS.md — 8s instead of 15s

TASKS.md T-010 specifies `timeout: 15_000`. This doc deviates to **8 seconds**. Reasoning:

- **Stop is `async: false`.** Claude Code blocks on hook completion before starting the user's next turn. 15s worst-case user-visible block is a lot for a "dry, unobtrusive" tool — the product brand is the opposite of getting in your way.
- **Typical `claude -p` latency for a 30-word output is 2–5s.** 8s has comfortable headroom for network hiccups.
- **Timeout is a soft failure.** Firing the timeout falls through to the silent-preset body, which is voice-consistent and delivers the stats. The user still gets a signal; they just don't get the LLM sentence.

The PR description flags this deviation explicitly so reviewers catch it.

### stdio and binary resolution

- `stdio`: default (pipes). Capture stdout and stderr. **Do not** inherit to parent — would leak claude's internal logging into the user's terminal.
- PATH resolution: let `execFile` find the binary. On `ENOENT` (claude missing from PATH) the Promise rejects with `err.code === 'ENOENT'`; the helper maps that to `ClaudeResult.ok = false, reason = 'enoent'`.
- Auth: `env: process.env` means the spawned `claude` inherits the user's Claude Code auth. No API keys, no proxy.

### Stdout pipeline

Applied in order inside `invokeClaudeP`:

1. **Strip ANSI escapes** — `/\x1b\[[0-9;]*[A-Za-z]/g` → `''`. `claude -p` in non-interactive mode probably does not emit ANSI, but we strip defensively so a future version change does not corrupt notification bodies.
2. **Trim** — drop leading/trailing whitespace.
3. **First non-empty line** — `.split('\n').find(l => l.trim().length > 0) ?? ''`. A model that returns a preamble + the sentence still gets normalized.
4. **Cap at 200 chars** — matches the `tool_input_summary` cap and OS notification truncation behavior.

Whitespace-only or empty result after this pipeline is treated as a failure and falls through to the silent-preset output.

### Stderr treatment

Captured by `execFileP`. Per TASKS.md: "Child stderr noise but zero exit → use stdout anyway (log the stderr to debug)." Non-zero exit → `ClaudeResult.ok = false, reason = 'nonzero'`. Either way the stderr is logged at `debug` from inside `invokeClaudeP` so the top-level flow doesn't see it.

## 3. Prompt construction

- **Config:** `loadConfig()` wrapped in `safeLoadConfig()` (same pattern as T-009 `post-tool-use.ts`). On `ConfigParseError` / `ConfigValidationError` / any thrown Error: `log('warn', …)`, fall back to `defaultConfig()`. A broken config does NOT short-circuit the notification — the user still gets a fallback ping.
- **Tone dispatch:** small `const TEMPLATES: Readonly<Record<TonePreset, TemplateBuilder>>` mapping each preset to its imported `buildPrompt`. No dynamic import, no switch; the table makes the exhaustiveness compile-checked.
- **Stats construction** from the entry snapshot:
  - `duration_minutes = Math.max(0, Math.floor((Date.now() - Date.parse(entry.started_at)) / 60_000))`. **Session age from `started_at`**, not time since last check-in. Matches PRD §6.4's "has been in a Claude Code session for {duration_minutes} minutes".
  - `tool_calls = entry.tool_calls_since_checkin`. The pre-reset count that tripped the threshold.
  - `last_tool_name = entry.last_tool_name`. Passthrough. Templates sanitize via `renderLastTool` → `sanitizeUntrustedField`.
  - `last_tool_summary = entry.last_tool_summary`. Passthrough.
  - **Subagent counters are NOT summed in.** Per F-003 deferral in current TASKS.md.
  - `last_assistant_message` from the stdin payload is **ignored** in v1. Additive for v2 if desired.
- **Silent short-circuit:** after config + stats, before invoking claude, check `config.tone.preset === 'silent'`. If so, `await notify({ title: 'Idle', body: TEMPLATES.silent(stats) })` and return. No child process, no LLM cost.

## 4. Flow diagram

```
stdin
  │
  ▼
parse JSON + object-shape guard
  │  (fail)   → log warn, exit 0
  ▼
payload.stop_hook_active === true?
  │  (yes)   → log debug "re-entrant Stop, skipping", exit 0
  ▼
isSessionId(payload.session_id)?
  │  (no)    → log warn, exit 0
  ▼
await consumePendingCheckin(sessionId)
  │
  ├── { ok: false, reason: 'not_pending'    } → exit 0 silently (hot path)
  ├── { ok: false, reason: 'not_found'      } → log debug, exit 0
  ├── { ok: false, reason: 'disabled'       } → log debug, exit 0
  ├── { ok: false, reason: 'timeout'        } → log warn,  exit 0
  │
  └── { ok: true, entry, cleared: true }
         │
         ▼
       config = safeLoadConfig()   (never throws; falls back to defaults)
         │
         ▼
       stats = buildStats(entry)
         │
         ▼
       tone = config.tone.preset
       preset === 'silent'?
         │  (yes)   → await notify({title:'Idle', body: TEMPLATES.silent(stats)}), exit 0
         ▼
       prompt = TEMPLATES[tone](stats)
       result = await invokeClaudeP(prompt)
         │
         ├── { ok: true,  output } → await notify({title:'Idle', body: output}), exit 0
         └── { ok: false, reason } → log debug "claude invocation failed",
                                      await notify({title:'Idle', body: TEMPLATES.silent(stats)}),
                                      exit 0
```

### Why `stop_hook_active` is at step 2, not later

The guard runs **before** `consumePendingCheckin`. Re-entrant Stop fires (which would happen if the hook's own `claude -p` call triggered a nested Stop hook in its own Claude Code instance, or if Claude Code re-fires Stop after the hook itself) **must not consume the pending flag**. If they did, the user would silently miss a check-in: the flag is cleared, but the notification fires from the wrong invocation (or doesn't fire at all). The step-2 placement is load-bearing; protect it against future "optimization" reordering.

### Outer `try/catch`

The entire body of `run(input)` sits inside a single outer try/catch whose only role is catching **unexpected** exceptions: programmer error, module loading failure, unexpected Node runtime behavior.

**It does NOT exist to guard `notify()` or `log()`.** Those primitives are contractually never-throw per CLAUDE.md. Do not add inner `try/catch` around either. The outer catch logs via `log()` at `error` level and exits 0. `notify()` is intentionally not called from the outer catch — at that point we have no idea what state we're in.

Every branch exits 0. Nothing writes to stdout (Claude Code owns stdout for protocol).

## 5. Error handling matrix

| Failure mode | Detection | Fallback | Log | User sees |
|---|---|---|---|---|
| Stdin empty string | `JSON.parse('')` throws | exit 0 | `warn` "stop: stdin is not valid JSON" | nothing |
| Stdin partial / truncated JSON | `JSON.parse` throws SyntaxError | exit 0 | `warn` with error message | nothing |
| Stdin parseable non-object (`null`, `true`, `false`, `[]`, number, bare string) | `typeof !== 'object' \|\| null \|\| isArray` | exit 0 | `warn` "stop: stdin is not a JSON object" | nothing |
| `stop_hook_active === true` | field check | exit 0 | `debug` "stop: re-entrant, skipping" | nothing |
| `session_id` missing / not string / fails brand check | `isSessionId` returns false | exit 0 | `warn` "stop: invalid session_id" | nothing |
| `consumePendingCheckin` → `not_pending` | union arm | exit 0 silently (hot path) | no log | nothing |
| `consumePendingCheckin` → `not_found` | union arm | exit 0 | `debug` | nothing |
| `consumePendingCheckin` → `disabled` | union arm | exit 0 | `debug` | nothing |
| `consumePendingCheckin` → `timeout` | union arm | exit 0 | `warn` | nothing |
| `ConfigParseError` | `safeLoadConfig` catches | `defaultConfig()` | `warn` | fallback notification (silent template body if tone→silent, else LLM attempt) |
| `ConfigValidationError` | `safeLoadConfig` catches | `defaultConfig()` | `warn` | same as above |
| `claude` not on PATH (ENOENT) | `err.code === 'ENOENT'` | `ClaudeResult.ok=false, reason:'enoent'` → silent template output | `debug` | silent-preset body |
| `claude` timeout (8s) | `err.signal === 'SIGTERM'` with child killed | `reason: 'timeout'` → silent | `debug` | silent-preset body |
| `claude` non-zero exit | `err.code !== 0` | `reason: 'nonzero'` → silent | `debug` with exit code + stderr | silent-preset body |
| `claude` stderr-with-zero-exit | zero exit, stderr non-empty | treat as success; use stdout | `debug` with stderr | LLM output |
| `claude` empty / whitespace-only stdout | after trim + first-line extraction, result is `''` | silent template output | `debug` | silent-preset body |
| `claude` multi-line stdout | pipeline takes first non-empty line | LLM output (first line) | — | first line of LLM output |
| `claude` ANSI-laden stdout | ANSI strip in pipeline | cleaned LLM output | — | cleaned LLM body |
| `claude` very long stdout (>200 chars) | pipeline's 200-char cap | truncated LLM output | — | capped body |
| Unexpected exception in `run()` body | outer `try/catch` | exit 0 | `error` with stack | nothing (notify NOT called) |

`notify()` itself: contractually never-throws. Omitted from the matrix as a non-failure.

## 6. Test matrix

One row per flow branch. All tests drive `run(input: string)` directly; the entry-point guard keeps module import side-effect-free. Tests mock `invokeClaudeP` (the exported helper), not `execFile` — a single seam, cheaper than `vi.mock('node:child_process')`.

| Test name | Input (stdin / state / config) | Expected (exit / notify args / state mutation) | Seam |
|---|---|---|---|
| `not_pending short-circuit` | valid stdin, session exists, no `pending_checkin` | exit 0, no notify, no state change | none |
| `invalid session_id` | stdin has empty string `session_id` | exit 0, no state read, warn log | none |
| `stop_hook_active guard` | stdin has `stop_hook_active: true` | exit 0, no `consumePendingCheckin` call, no notify | none |
| `silent preset short-circuits claude call` | pending session, config tone=silent | exit 0, notify body = `"<m>m / <n> tool calls"`, `invokeClaudeP` not called | `invokeClaudeP` mock throws if invoked |
| `dry preset happy path` | pending session, tone=dry | exit 0, notify body = trimmed LLM output | `invokeClaudeP` → `{ok:true, output:'Go stretch.'}` |
| `earnest preset happy path` | tone=earnest | same | same |
| `absurdist preset happy path` | tone=absurdist | same | same |
| `claude timeout falls back to silent output` | tone=dry | notify body byte-identical to silent template, debug log entry | `invokeClaudeP` → `{ok:false, reason:'timeout'}` |
| `claude ENOENT falls back` | tone=dry | same body, debug log with `reason:'enoent'` | `invokeClaudeP` → `{ok:false, reason:'enoent'}` |
| `claude non-zero exit falls back` | tone=dry | same body, debug log with `reason:'nonzero'` | `invokeClaudeP` → `{ok:false, reason:'nonzero'}` |
| `claude empty stdout falls back` | tone=dry | same body as silent fallback | `invokeClaudeP` → `{ok:true, output:''}` |
| `claude whitespace-only stdout falls back` | tone=dry | same | `invokeClaudeP` → `{ok:true, output:'   \n\n  '}` |
| `claude multi-line stdout → first non-empty line` | tone=dry | notify body = first non-empty line only | `invokeClaudeP` → `{ok:true, output:'\n\nFirst.\nSecond.\n'}` |
| `ANSI escape codes stripped before notify` | tone=dry | notify body contains no `\x1b` | `invokeClaudeP` simulates ANSI in output |
| `long stdout capped at 200 chars` | tone=dry, claude returns 500-char output | `notify` body `.length === 200` exactly | `invokeClaudeP` returns 500-char output |
| `ConfigValidationError → defaults, still notifies` | pending session, `config.toml` has invalid preset | exit 0, notify called with a valid body | `invokeClaudeP` mock returns canned output |
| `consumePendingCheckin reason=not_found` | stdin session_id unknown to state | exit 0, debug log, no notify | none |
| `consumePendingCheckin reason=disabled` | pending session marked disabled | exit 0, debug log, no notify | none |
| `consumePendingCheckin reason=timeout` | forced lock contention | exit 0, warn log, no notify | none |
| `malformed stdin: empty` | `''` | exit 0, warn log, no state read | none |
| `malformed stdin: partial JSON` | `'{ "session'` | exit 0, warn log | none |
| `malformed stdin: null` | `'null'` | exit 0, warn log "not a JSON object" | none |
| `malformed stdin: true` | `'true'` | same | none |
| `malformed stdin: array` | `'[]'` | same | none |
| `malformed stdin: number` | `'42'` | same | none |
| `no stdout` | any happy path | `process.stdout.write` spy records zero bytes | spy |
| `notify is awaited` | any happy path | `run()` Promise resolves only after `notify` resolves | instrument notify mock with a gated Promise |

## 7. Open questions

None unresolved pre-draft. Pre-draft decisions (Q1–Q7 + the 8s timeout and three review concerns) are all baked in above. Any questions surfaced during implementation go here in the Phase 2 PR, not this doc.
