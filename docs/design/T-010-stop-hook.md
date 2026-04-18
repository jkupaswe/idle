# T-010 — Stop hook design doc

Fires when the agent finishes responding. If a check-in is pending, generates a one-sentence break suggestion via `claude -p` and triggers a native notification. Composes six shipped / proposed primitives: `consumePendingCheckin`, `loadConfig`, the four tone-preset `buildPrompt` functions, a **new** `invokeClaudeP` subprocess helper, a **new** `normalizeClaudeOutput` pure function, and `notify`.

Design phase only; no `src/hooks/stop.ts` or tests in this PR.

## Prerequisites — must land before Phase 2

**P-1: Extend `src/core/notify.ts` to accept `method` in addition to `sound`.**

Current `NotifyInput` shape (verified against `origin/main`):

```ts
export interface NotifyInput {
  title: string;
  body: string;
  sound?: boolean;
}
```

`config.notifications.method` (`'native' | 'terminal' | 'both'`) is not honored by `notify()` today — it dispatches purely on `process.platform`. Decision X requires the Stop hook to forward both `sound` and `method` to every `notify()` call. Shape this design targets:

```ts
export type NotificationMethod = 'native' | 'terminal' | 'both';

export interface NotifyInput {
  title: string;
  body: string;
  sound?: boolean;
  method?: NotificationMethod;     // default 'native' when undefined
}
```

Core-owned change; out of Hooks scope. T-010 design is approved-but-blocked until P-1 ships. Flagged in the PR description as a prerequisite.

## 1. Proposed types

No new on-disk types. Every payload, state, and stats shape already exists.

Reused, imported as-is:

- `StopPayload` (`src/lib/types.ts`) — `session_id`, `transcript_path`, `cwd`, `hook_event_name: 'Stop'`, `stop_hook_active?`, `last_assistant_message?`.
- `SessionEntry` — fields returned inside the `consumePendingCheckin` success snapshot. Pre-reset values; counters reflect what tripped the threshold.
- `CheckInStats` — `{ duration_minutes, tool_calls, last_tool_name?, last_tool_summary? }`.
- `TonePreset` — `'dry' | 'earnest' | 'absurdist' | 'silent'`.
- `NotificationsConfig` — `{ method: 'native' | 'terminal' | 'both', sound: boolean }` from `IdleConfig`.
- `SessionId` + `isSessionId` — brand guard.

Two new *internal* types + one new exported pure function, scoped to `src/hooks/stop.ts`:

```ts
type TemplateBuilder = (stats: CheckInStats) => string;

type ClaudeResult =
  | { ok: true; rawOutput: string }                 // raw stdout, no transforms
  | { ok: false; reason: 'timeout' | 'enoent' | 'nonzero' | 'killed' };

export function normalizeClaudeOutput(raw: string): string;
```

Two explicit layers so transforms are unit-testable without a subprocess:

- **`invokeClaudeP(prompt)`** owns the subprocess concern. Returns **raw stdout** on success — no trimming, no ANSI strip, no cap. That's the "test theater" Codex flagged: mocking this seam must not also mock the transforms.
- **`normalizeClaudeOutput(raw)`** is a pure function. Same input, same output, no side effects. Exported so a dedicated test suite hits it directly with no mocks.

The hook flow calls both in sequence; neither knows about the other's contract beyond `string`-in, `string`-out.

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

TASKS.md T-010 currently specifies `timeout: 15_000`. **Per Decision Y this PR also updates TASKS.md T-010 to `8_000`** alongside the design revision. Reasoning (cited in both docs):

- **Stop is `async: false`.** Claude Code blocks on hook completion before starting the user's next turn. 15s worst-case user-visible block is a lot for a "dry, unobtrusive" tool — the product brand is the opposite of getting in your way.
- **Typical `claude -p` latency for a 30-word output is 2–5s.** 8s has comfortable headroom for network hiccups.
- **Timeout is a soft failure.** Firing the timeout falls through to the silent-preset body, which is voice-consistent and delivers the stats. The user still gets a signal; they just don't get the LLM sentence.

### stdio and binary resolution

- `stdio`: default (pipes). Capture stdout and stderr inside the helper. **Do not** inherit to parent — would leak claude's internal logging into the user's terminal.
- PATH resolution: let `execFile` find the binary. On `ENOENT` (claude missing from PATH) the Promise rejects with `err.code === 'ENOENT'`; the helper maps that to `{ ok: false, reason: 'enoent' }`.
- Auth: `env: process.env` means the spawned `claude` inherits the user's Claude Code auth. No API keys, no proxy.

### stderr treatment

Captured by `execFileP`. Non-zero exit → `{ ok: false, reason: 'nonzero' }`, with stderr logged at `debug` alongside the exit code. **Zero exit with stderr content is NOT a failure** — logged at `debug` but the stdout is returned as `rawOutput`. Per Decision Y this policy also lands in TASKS.md. Reasoning: CLI tools routinely emit stderr during normal operation (deprecation warnings, info logs); treating any stderr as failure would cause near-universal fallback.

### `invokeClaudeP` returns

On success: `{ ok: true, rawOutput: string }` — stdout as-is, with no transformations. Even empty. Even multi-line. Even ANSI-laden. The helper's job ends there.

On failure: `{ ok: false, reason: 'timeout' | 'enoent' | 'nonzero' | 'killed' }`. `killed` is reserved for signals that aren't SIGTERM-from-timeout (e.g. a user hitting Ctrl+C on the parent Claude Code); in practice this is rare.

The helper swallows no errors. Any throw inside it propagates to the hook's outer `try/catch`.

## 3. Output normalization

Pure function; no side effects. Consumed by the hook after a successful `invokeClaudeP`. Exported so a dedicated test suite hits it directly.

```ts
export function normalizeClaudeOutput(raw: string): string;
```

Pipeline, applied in order:

1. **Strip ANSI escapes** — `/\x1b\[[0-9;]*[A-Za-z]/g` → `''`. `claude -p` in non-interactive mode probably does not emit ANSI, but we strip defensively so a future version change does not corrupt notification bodies.
2. **Trim** — drop leading/trailing whitespace.
3. **First non-empty line** — `.split('\n').find(l => l.trim().length > 0)?.trim() ?? ''`. A model that returns a preamble + the sentence still gets normalized.
4. **Cap at 200 chars** — matches the `tool_input_summary` cap and OS notification truncation behavior.

**Empty input returns empty string.** The pure function does not decide fallback — it returns `''` and the caller chooses what to do with it. This keeps the function testable in isolation (no sentinels, no Result type, no fallback coupling).

## 4. Prompt construction and config wiring

- **Config:** `loadConfig()` wrapped in `safeLoadConfig()` (same pattern as T-009 `post-tool-use.ts`). On `ConfigParseError` / `ConfigValidationError` / any thrown Error: `log('warn', …)`, fall back to `defaultConfig()`. A broken config does NOT short-circuit the notification — the user still gets a fallback ping.
- **Tone dispatch:** small `const TEMPLATES: Readonly<Record<TonePreset, TemplateBuilder>>` mapping each preset to its imported `buildPrompt`. No dynamic import, no switch; the table makes the exhaustiveness compile-checked.
- **Stats construction** from the entry snapshot:
  - `duration_minutes = Math.max(0, Math.floor((Date.now() - Date.parse(entry.started_at)) / 60_000))`. **Session age from `started_at`**, not time since last check-in. Matches PRD §6.4's "has been in a Claude Code session for {duration_minutes} minutes".
  - `tool_calls = entry.tool_calls_since_checkin`. The pre-reset count that tripped the threshold.
  - `last_tool_name = entry.last_tool_name`. Passthrough. Templates sanitize via `renderLastTool` → `sanitizeUntrustedField`.
  - `last_tool_summary = entry.last_tool_summary`. Passthrough.
  - **Subagent counters are NOT summed in.** Per F-003 deferral in current TASKS.md.
  - `last_assistant_message` from the stdin payload is **ignored** in v1. Additive for v2.
- **Notification options (Decision X):** every `notify()` call forwards both notification fields from config:

  ```ts
  const notifOpts = {
    title: 'Idle',
    sound: config.notifications.sound,
    method: config.notifications.method,
  } as const;
  await notify({ ...notifOpts, body });
  ```

  Applies to all three call sites: silent-preset success, LLM-preset success, and every fallback path (timeout / ENOENT / nonzero / empty-after-normalize). Prereq P-1 is what makes `method` actually honored by `notify()`.
- **Silent short-circuit:** after config + stats, before invoking claude, check `config.tone.preset === 'silent'`. If so, `await notify({ ...notifOpts, body: TEMPLATES.silent(stats) })` and return. No child process, no LLM cost.

## 5. Flow diagram

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
  ├── { ok: false, reason: 'not_pending' } → exit 0 silently (hot path)
  ├── { ok: false, reason: 'not_found'   } → log debug, exit 0
  ├── { ok: false, reason: 'disabled'    } → log debug, exit 0
  ├── { ok: false, reason: 'timeout'     } → log warn,  exit 0
  │
  └── { ok: true, entry, cleared: true }
         │
         ▼
       config    = safeLoadConfig()        (never throws)
       stats     = buildStats(entry)
       notifOpts = { title:'Idle', sound, method }
       silentBody= TEMPLATES.silent(stats)
         │
         ▼
       config.tone.preset === 'silent'?
         │  (yes)   → await notify({ ...notifOpts, body: silentBody }), exit 0
         ▼
       prompt = TEMPLATES[tone](stats)
       result = await invokeClaudeP(prompt)
         │
         ├── { ok: false, reason }   → log debug, await notify({ ...notifOpts, body: silentBody }), exit 0
         │
         └── { ok: true, rawOutput }
                │
                ▼
             body = normalizeClaudeOutput(rawOutput)
                │
                ├── body === ''        → log debug "claude empty after normalize",
                │                          await notify({ ...notifOpts, body: silentBody }),
                │                          exit 0
                │
                └── body !== ''        → await notify({ ...notifOpts, body }), exit 0
```

### Why `stop_hook_active` is at step 2, not later

The guard runs **before** `consumePendingCheckin`. Re-entrant Stop fires (which would happen if the hook's own `claude -p` call triggered a nested Stop hook in its own Claude Code instance, or if Claude Code re-fires Stop after the hook itself) **must not consume the pending flag**. If they did, the user would silently miss a check-in: the flag is cleared, but the notification fires from the wrong invocation (or doesn't fire at all). The step-2 placement is load-bearing; protect it against future "optimization" reordering.

### Outer `try/catch`

The entire body of `run(input)` sits inside a single outer try/catch whose only role is catching **unexpected** exceptions: programmer error, module loading failure, unexpected Node runtime behavior.

**It does NOT exist to guard `notify()` or `log()`.** Those primitives are contractually never-throw per CLAUDE.md. Do not add inner `try/catch` around either. The outer catch logs via `log()` at `error` level and exits 0. `notify()` is intentionally not called from the outer catch — at that point we have no idea what state we're in.

Every branch exits 0. Nothing writes to stdout (Claude Code owns stdout for protocol).

## 6. Error handling matrix

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
| `ConfigParseError` | `safeLoadConfig` catches | `defaultConfig()` | `warn` | fallback notification (silent body if tone→silent, else LLM attempt) with default sound/method |
| `ConfigValidationError` | `safeLoadConfig` catches | `defaultConfig()` | `warn` | same |
| `claude` not on PATH (ENOENT) | `err.code === 'ENOENT'` | silent body, with configured sound/method | `debug` | silent-preset body via configured method |
| `claude` timeout (8s) | child killed by timeout | silent body | `debug` | silent-preset body via configured method |
| `claude` non-zero exit | `err.code !== 0` | silent body | `debug` with exit code + stderr | silent-preset body via configured method |
| `claude` zero exit, stderr non-empty | zero exit + stderr has content | treat as success; use stdout | `debug` with stderr | LLM output via configured method |
| `normalizeClaudeOutput` returns `''` (empty / whitespace-only / ANSI-only) | `body === ''` after pipeline | silent body | `debug` "claude empty after normalize" | silent-preset body via configured method |
| Unexpected exception in `run()` body | outer `try/catch` | exit 0 | `error` with stack | nothing (notify NOT called) |

`notify()` itself: contractually never-throws. Omitted from the matrix as a non-failure.

## 7. Test matrix

Tests split across **three layers** so the subprocess dance and the pure transforms can't fake-test each other.

### 7a. Hook-level tests (`tests/hooks/stop.test.ts`)

Drive `run(input: string)` directly; entry-point guard keeps module import side-effect-free. Mock `invokeClaudeP` (single seam). Assert flow control, fallback routing, config handling, and `notify()` args.

| Test name | Input (stdin / state / config) | Expected (exit / notify args / state) | Seam |
|---|---|---|---|
| `not_pending short-circuit` | valid stdin, session exists, no `pending_checkin` | exit 0, no notify, no state change | none |
| `invalid session_id` | stdin has empty `session_id` | exit 0, no state read, warn log | none |
| `stop_hook_active guard` | stdin has `stop_hook_active: true` | exit 0, no `consumePendingCheckin`, no notify | none |
| `silent preset short-circuits claude call` | pending session, tone=silent | exit 0, notify body = `"<m>m / <n> tool calls"`, `invokeClaudeP` NOT called | `invokeClaudeP` mock throws on call |
| `dry preset happy path` | pending session, tone=dry | exit 0, notify body = normalized LLM output | `invokeClaudeP` → `{ok:true, rawOutput:'Go stretch.'}` |
| `earnest preset happy path` | tone=earnest | same | same |
| `absurdist preset happy path` | tone=absurdist | same | same |
| `notify forwards config.notifications.sound` | tone=silent, config sound=true | notify called with `sound: true` | none |
| `notify forwards config.notifications.method` | tone=silent, config method='terminal' | notify called with `method: 'terminal'` | none |
| `notify forwards sound + method on LLM-success path` | tone=dry, sound=true, method='both' | notify called with `{sound:true, method:'both'}` | `invokeClaudeP` → `{ok:true, rawOutput:'Go.'}` |
| `notify forwards sound + method on fallback path` | tone=dry, sound=true, method='terminal', claude times out | notify called with same fields and silent body | `invokeClaudeP` → `{ok:false, reason:'timeout'}` |
| `claude timeout falls back to silent body` | tone=dry | body byte-identical to silent template, debug log | `invokeClaudeP` → `{ok:false, reason:'timeout'}` |
| `claude ENOENT falls back` | tone=dry | same, debug log `reason:'enoent'` | `invokeClaudeP` → `{ok:false, reason:'enoent'}` |
| `claude non-zero exit falls back` | tone=dry | same, debug log `reason:'nonzero'` | `invokeClaudeP` → `{ok:false, reason:'nonzero'}` |
| `empty-after-normalize falls back` | tone=dry | silent body, debug log "empty after normalize" | `invokeClaudeP` → `{ok:true, rawOutput:'   \n\n '}` |
| `ConfigValidationError → defaults, still notifies` | pending session, invalid config.toml | exit 0, notify called with a valid body | `invokeClaudeP` mock returns canned output |
| `consumePendingCheckin reason=not_found` | stdin session_id unknown | exit 0, debug log, no notify | none |
| `consumePendingCheckin reason=disabled` | pending session marked disabled | exit 0, debug log, no notify | none |
| `consumePendingCheckin reason=timeout` | forced lock contention | exit 0, warn log, no notify | none |
| `malformed stdin: empty / partial / null / true / [] / number` | each as own row | exit 0, warn log, no state read | none |
| `no stdout` | any happy path | `process.stdout.write` spy records zero bytes | spy |
| `notify is awaited` | any happy path | `run()` resolves only after `notify` resolves | gated notify mock |

### 7b. `normalizeClaudeOutput` unit tests (`tests/hooks/normalize-claude-output.test.ts`)

Pure function. No mocks needed.

| Test name | Input | Expected output |
|---|---|---|
| `empty string → empty` | `''` | `''` |
| `whitespace only → empty` | `'   \n\n  '` | `''` |
| `ANSI only → empty` | `'\x1b[31m\x1b[0m'` | `''` |
| `single line, trimmed` | `'  Go stretch.  '` | `'Go stretch.'` |
| `multi-line → first non-empty` | `'\n\nGo stretch.\nSecond line.\n'` | `'Go stretch.'` |
| `ANSI codes stripped` | `'\x1b[31mgo\x1b[0m for a walk'` | `'go for a walk'` |
| `ANSI mid-line with multi-line` | `'\n\x1b[32mFirst.\x1b[0m\nSecond.'` | `'First.'` |
| `exactly 200 chars → pass through` | 200-char string | same string, 200 chars |
| `201 chars → capped to 200` | 201-char string | first 200 chars |
| `500 chars → capped to 200` | 500-char string | `.length === 200` |

### 7c. `invokeClaudeP` integration tests (`tests/hooks/invoke-claude-p.integration.test.ts`)

Exercise the real subprocess via a stub script `tests/fixtures/fake-claude.sh` (executable shell script) whose behavior is parameterized by argv or env. The test sets `PATH` so `fake-claude` resolves to our stub, then calls `invokeClaudeP` (with the binary name overridable for tests — see open question below).

| Test name | Stub behavior | Expected `ClaudeResult` |
|---|---|---|
| `happy path` | stub writes stdout, exit 0 | `{ok:true, rawOutput:'<stub stdout>'}` |
| `exit 1` | stub writes stderr, exit 1 | `{ok:false, reason:'nonzero'}` |
| `ENOENT` | `PATH` set to empty so binary not found | `{ok:false, reason:'enoent'}` |
| `timeout` | stub sleeps 10s (timeout 8s) | `{ok:false, reason:'timeout'}` |
| `stderr with zero exit` | stub writes to stderr, exit 0 | `{ok:true, rawOutput:'<stdout>'}` (not a failure) |

The stub script fixture is committed under `tests/fixtures/fake-claude.sh` with executable bit set. Lives alongside other hook fixtures.

## 8. Open questions

One, surfaced by the two-layer split:

- **Q: Binary name injection for `invokeClaudeP` integration tests.** The real helper calls `execFile('claude', …)`. Integration tests need a way to point it at the stub script. Options: (a) export an internal-facing variant `invokeClaudeP(prompt, { binary = 'claude' })` with the binary as an option; (b) rely on `PATH` manipulation alone; (c) a `IDLE_CLAUDE_BINARY` env var read once at call time. Proposal: **(c)** — matches the `IDLE_NOTIFY_PLATFORM` pattern in `notify.ts`, keeps the public signature clean, and is trivially mockable. Accept (c), or pick another option?

No other open questions. Pre-draft decisions (A1–A7 + the 8s timeout + three review concerns + Decisions X/Y/Z) are all baked in above.
