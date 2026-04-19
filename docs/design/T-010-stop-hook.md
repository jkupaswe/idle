# T-010 — Stop hook design doc

Fires when the agent finishes responding. If a check-in is pending, generates a one-sentence break suggestion via `claude -p` and triggers a native notification. Composes six shipped / proposed primitives: `consumePendingCheckin`, `loadConfig`, the four tone-preset `buildPrompt` functions, a **new** `invokeClaudeP` subprocess helper (in its own module), a **new** `normalizeClaudeOutput` pure function (in its own module), and `notify`.

Design phase only; no `src/hooks/stop.ts` or tests in this PR.

## Prerequisites — must land before Phase 2

**P-1: Extend `src/core/notify.ts` to accept `method` in addition to `sound`.**

Current `NotifyInput` (verified against `origin/main`):

```ts
export interface NotifyInput {
  title: string;
  body: string;
  sound?: boolean;
}
```

`config.notifications.method` (`'native' | 'terminal' | 'both'`) is not honored today; dispatch is purely `process.platform`. Decision X requires the Stop hook to forward both `sound` and `method`. Target shape:

```ts
export type NotificationMethod = 'native' | 'terminal' | 'both';

export interface NotifyInput {
  title: string;
  body: string;
  sound?: boolean;
  method?: NotificationMethod;     // default 'native' when undefined
}
```

### P-1 behavior matrix (authoritative — any Core implementation must match)

| `method` | macOS | Linux (notify-send present) | Linux (no notify-send) | Other platforms |
|---|---|---|---|---|
| `'native'` (default) | osascript | notify-send | stderr line (existing fallback) | stderr line |
| `'terminal'` | stderr line ONLY; no osascript call | stderr line ONLY; no notify-send call | stderr line | stderr line |
| `'both'` | osascript **and** stderr line | notify-send **and** stderr line | stderr line (one delivery; no native path) | stderr line |

Required semantics:

1. **`'terminal'` never invokes a platform notifier.** Users who opt into terminal-only must not see OS-level popups. If the stderr write itself fails, swallow silently (matches existing `writeStderr` contract).
2. **`'both'` is two deliveries, not one-with-fallback.** On macOS, users see the system notification *and* a stderr line. On Linux with `notify-send`, the same. Failure of one delivery path does NOT suppress the other.
3. **`'native'` failure falls back to stderr** (existing behavior; preserved). Does NOT upgrade to `'both'` semantics on success.
4. **Unknown `method` value** (future / invalid config) is treated as `'native'` for forward-compatibility. Config validation already rejects unknown values; this is belt-and-braces.
5. **`sound` is orthogonal.** Ignored on `'terminal'`; passed through on `'native'` and `'both'` (on each native delivery).

Core-owned change; out of Hooks scope. T-010 design is approved-but-blocked until P-1 ships matching this matrix. Flagged in the PR description as a prerequisite.

## 1. Proposed types and file layout

Three implementation files owned by this ticket under `src/hooks/`, plus three test files and one cross-platform fixture under `tests/`:

Implementation:

- **`src/hooks/stop.ts`** — entry point, `run(input)` flow control.
- **`src/hooks/invoke-claude-p.ts`** — subprocess helper. Separate module so it's a real import seam for tests (`vi.mock('./invoke-claude-p.js')` reliably intercepts; same-module locals in ESM do not).
- **`src/hooks/normalize-claude-output.ts`** — pure transforms. Separate module so dedicated tests can hit it with no mocks.

Tests and fixtures:

- **`tests/hooks/stop.test.ts`** — hook-level flow and fallback tests.
- **`tests/hooks/invoke-claude-p.test.ts`** — subprocess helper tests, split into **UNIT** describe block (mocks `node:child_process`) and **INTEGRATION** describe block (real `execFile` against the fixture below).
- **`tests/hooks/normalize-claude-output.test.ts`** — pure-function unit tests; no mocks.
- **`tests/fixtures/fake-claude-p.mjs`** — Node script fixture (cross-platform; not a shell script). Accepts `--stdout <text>`, `--stderr <text>`, `--exit <N>`, `--sleep-ms <N>`. Invoked from integration tests as `execClaudeLike(process.execPath, [fixturePath, ...flags], timeoutMs)`.
- **`tests/fixtures/stop-*.json`** — synthetic hook payloads.

No new on-disk types. Reused shapes imported as-is:

- `StopPayload` (`src/lib/types.ts`) — `session_id`, `transcript_path`, `cwd`, `hook_event_name: 'Stop'`, `stop_hook_active?`, `last_assistant_message?`.
- `SessionEntry` — the `consumePendingCheckin` success snapshot carries pre-reset values.
- `CheckInStats` — `{ duration_minutes, tool_calls, last_tool_name?, last_tool_summary? }`.
- `TonePreset` — `'dry' | 'earnest' | 'absurdist' | 'silent'`.
- `NotificationsConfig` — `{ method, sound }` from `IdleConfig`.
- `SessionId` + `isSessionId` — brand guard.

New module exports:

```ts
// src/hooks/invoke-claude-p.ts
export type ClaudeResult =
  | { ok: true; rawOutput: string }                 // stdout as-is, no transforms
  | { ok: false; reason: 'timeout' | 'enoent' | 'nonzero' | 'killed' };

/** Production API — `execFile('claude', ['-p', prompt], …)` with the 8s timeout. */
export async function invokeClaudeP(prompt: string): Promise<ClaudeResult>;

/**
 * Module-local helper exported only so integration tests can exercise
 * real `execFile` timeout / ENOENT / signal behavior against
 * `tests/fixtures/fake-claude-p.mjs`. Production code does NOT call
 * this directly — the hook path only uses `invokeClaudeP`.
 */
export async function execClaudeLike(
  binary: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<ClaudeResult>;

// src/hooks/normalize-claude-output.ts
export function normalizeClaudeOutput(raw: string): string;

// src/hooks/stop.ts (internal)
type TemplateBuilder = (stats: CheckInStats) => string;
```

`TemplateBuilder` keys a tone → builder dispatch table so flow control does not hand-dispatch on the union. `execClaudeLike` is a module-local helper; it is not re-exported from any package index, and `invokeClaudeP` is a thin wrapper that calls `execClaudeLike('claude', ['-p', prompt], 8_000)` with the production defaults.

## 2. Child process invocation

Module: `src/hooks/invoke-claude-p.ts`. Sole responsibility: run `claude -p`, interpret the result, return `ClaudeResult`. No transforms. No output pipeline.

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

TASKS.md T-010 in this PR is updated to `8_000` alongside the design. Reasoning (in both docs):

- **Stop is `async: false`.** Claude Code blocks on hook completion before the next turn. 15s worst-case user-visible block is a lot for a "dry, unobtrusive" tool.
- **Typical `claude -p` latency for a 30-word output is 2–5s.** 8s has headroom.
- **Timeout is a soft failure.** Falls through to the silent-preset body — user still gets a signal.

### stdio and binary resolution

- `stdio`: default (pipes). Capture stdout and stderr inside the helper. **Do not** inherit to parent — would leak claude's internal logging into the user's terminal.
- PATH resolution: let `execFile` find the binary. On `ENOENT` the Promise rejects with `err.code === 'ENOENT'`; mapped to `{ ok: false, reason: 'enoent' }`.
- Auth: `env: process.env` — the spawned `claude` inherits the user's Claude Code auth.

### stderr treatment

Captured by `execFileP`. **Zero exit with stderr content is NOT a hard failure** — logged at `debug` inside the helper, stdout returned as `rawOutput`. Non-zero exit → `{ ok: false, reason: 'nonzero' }`, with stderr logged at `debug` alongside the exit code. Per Decision Y, this policy also lands in TASKS.md. Reasoning: CLI tools routinely emit stderr during normal operation; treating any stderr as failure would cause near-universal fallback.

### Return contract

Success: `{ ok: true, rawOutput: string }`. stdout as-is — empty, multi-line, ANSI-laden, whatever the binary returned. The helper's job ends there.

Failure: `{ ok: false, reason: 'timeout' | 'enoent' | 'nonzero' | 'killed' }`. `killed` is reserved for signals other than the timeout SIGTERM (e.g. user Ctrl+C on the parent).

The helper swallows no unrecoverable errors; any unexpected throw propagates to `stop.ts`'s post-consume catch (see §5).

## 3. Output normalization

Module: `src/hooks/normalize-claude-output.ts`. Pure. No side effects. Exported so a dedicated test suite hits it with no mocks.

```ts
export function normalizeClaudeOutput(raw: string): string;
```

Pipeline, in order:

1. **Strip ANSI escapes** — `/\x1b\[[0-9;]*[A-Za-z]/g` → `''`. `claude -p` in non-interactive mode probably does not emit ANSI, but we strip defensively.
2. **Trim** — drop leading/trailing whitespace.
3. **First non-empty line** — `.split('\n').find(l => l.trim().length > 0)?.trim() ?? ''`.
4. **Cap at 200 chars** — matches `tool_input_summary` cap and OS notification truncation.

**Empty input returns `''`.** Pure function does not decide fallback; the caller picks.

## 4. Prompt construction and config wiring

- **Config:** `loadConfig()` wrapped in `safeLoadConfig()` (same pattern as T-009 `post-tool-use.ts`). On `ConfigParseError` / `ConfigValidationError` / any thrown Error: log warn, fall back to `defaultConfig()`. A broken config does NOT short-circuit the notification.
- **Tone dispatch:** `const TEMPLATES: Readonly<Record<TonePreset, TemplateBuilder>>` mapping each preset to its imported `buildPrompt`. Table → compile-checked exhaustiveness.
- **Stats** built from the `consumePendingCheckin` snapshot:
  - `duration_minutes = Math.max(0, Math.floor((Date.now() - Date.parse(entry.started_at)) / 60_000))`. Session age from `started_at`.
  - `tool_calls = entry.tool_calls_since_checkin`. Pre-reset count.
  - `last_tool_name` / `last_tool_summary`: passthrough; templates sanitize via `renderLastTool` → `sanitizeUntrustedField`.
  - **Subagent counters NOT summed.** F-003 deferred.
  - `last_assistant_message` **ignored** in v1.
- **Notification options (Decision X):** every call site spreads the same `notifOpts`:
  ```ts
  const notifOpts = {
    title: 'Idle',
    sound: config.notifications.sound,
    method: config.notifications.method,
  } as const;
  await notify({ ...notifOpts, body });
  ```
  Applied on silent-preset success, LLM success, and every fallback. `method` is honored only after P-1 lands.
- **Silent short-circuit:** if `config.tone.preset === 'silent'` after config + stats, `await notify({ ...notifOpts, body: TEMPLATES.silent(stats) })` and return 0. No child process, no LLM cost.

## 5. Flow + two-phase try/catch (no silent-loss guarantee)

Once `consumePendingCheckin` returns `{ ok: true }`, the `pending_checkin` flag has been atomically cleared. From that moment until the hook exits, **every error path must attempt a notification** — otherwise a bug downstream silently drops the user's check-in.

### Three-tier fallback strategy

Body strings used by `notify()` come in three tiers:

1. **Happy path:** `normalizeClaudeOutput(result.rawOutput)` — the LLM sentence.
2. **Known-failure fallback:** `TEMPLATES.silent(stats)` — the silent-preset output (`"<m>m / <n> tool calls"`). Used on `invokeClaudeP` non-ok results, normalize-empty, and `ConfigValidationError`. Requires `stats` and thus `buildStats` to have succeeded.
3. **Degraded fallback:** the literal string **`"Idle check-in"`** with notify opts `{ title: 'Idle', body: 'Idle check-in' }` (no `sound`, no `method`). Used only by the inner catch when post-consume work threw before we had usable `notifOpts`/`silentBody`. Does not depend on any post-consume work.

The degraded body is voice-consistent (dry, terse), independent of any post-consume state, and distinguishable in the debug log so operators can tell "tier 3 fired" from "config threw, tier 2".

### Two try/catch layers

- **Outer (pre-consume) catch** — wraps stdin parse, guards, and `consumePendingCheckin` itself. On unexpected throw: log at `error`, exit 0 with **no notify**. The pending flag is still set, so the next Stop fires the check-in cleanly.
- **Inner (post-consume) catch** — the `[INNER TRY]` boundary starts **immediately** after `consumePendingCheckin` returns `{ ok: true }`, before any other post-consume work. It wraps `safeLoadConfig`, `buildStats`, `TEMPLATES.silent(stats)`, `notifOpts` construction, the silent short-circuit `notify`, tone dispatch (`TEMPLATES[preset](stats)`), `invokeClaudeP`, `normalizeClaudeOutput`, and the final `notify` call. On unexpected throw: log at `error` with the throwing phase identified in the message, then `await notify({ title: 'Idle', body: 'Idle check-in' })` (tier 3), exit 0. The pending flag is already cleared; the user still sees a signal.

`notify()` is placed **inside** the inner try, not outside. CLAUDE.md's never-throw contract makes this defense-in-depth rather than strictly necessary — a hypothetical future P-1 implementation that breaks the contract would still be recoverable because the catch would fire with the degraded fallback. The catch itself calls `notify()` exactly once with the tier-3 body; if that call also throws (contract violation by the Core primitive), it propagates to the outer catch, which logs and exits. That chained-failure path is unreachable under the contract and is not engineered around further.

### Flow diagram

```
stdin
  │
  ▼
[OUTER TRY — pre-consume]
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
       [INNER TRY — post-consume; boundary starts HERE]
         │
         ▼
       config     = safeLoadConfig()                     (throw → INNER CATCH)
       stats      = buildStats(entry)                    (throw → INNER CATCH)
       silentBody = TEMPLATES.silent(stats)              (throw → INNER CATCH)
       notifOpts  = { title:'Idle', sound, method }      (throw → INNER CATCH)
         │
         ▼
       config.tone.preset === 'silent'?
         │  (yes) → await notify({ ...notifOpts, body: silentBody }), exit 0   [tier 2]
         ▼
       prompt = TEMPLATES[tone](stats)                    (throw → INNER CATCH)
       result = await invokeClaudeP(prompt)
         │
         ├── { ok: false, reason }  → log debug,
         │                              await notify({ ...notifOpts, body: silentBody }),   [tier 2]
         │                              exit 0
         │
         └── { ok: true, rawOutput }
                │
                ▼
             body = normalizeClaudeOutput(rawOutput)      (throw → INNER CATCH)
                │
                ├── body === '' → log debug "claude empty after normalize",
                │                   await notify({ ...notifOpts, body: silentBody }),       [tier 2]
                │                   exit 0
                │
                └── body !== '' → await notify({ ...notifOpts, body }), exit 0              [tier 1]
       [INNER CATCH] → log error 'stop: post-consume unexpected throw',
                        await notify({ title:'Idle', body: 'Idle check-in' }),              [tier 3]
                        exit 0
[OUTER CATCH] → log error 'stop: pre-consume unexpected throw', exit 0 (no notify; pending still set)
```

### Why `stop_hook_active` is at step 2, not later

Runs **before** `consumePendingCheckin`. Re-entrant Stop fires (hook's own `claude -p` nesting, or Claude Code re-firing Stop) **must not consume the pending flag** — clearing it from the wrong invocation would silently drop the user's check-in. Load-bearing ordering; protect against future reordering. CLAUDE.md compliance: the inner try wraps `notify()` as defense-in-depth; the inner catch itself is not wrapped and trusts the never-throw contract. `log()` is never wrapped anywhere. No try/catch is added at the primitive level — wrapping is at the flow boundary (post-consume work).

## 6. Error handling matrix

| Failure mode | Detection | Fallback | Log | User sees |
|---|---|---|---|---|
| Stdin empty string | `JSON.parse('')` throws in outer try | exit 0 | `warn` "stop: stdin is not valid JSON" | nothing |
| Stdin partial / truncated JSON | `JSON.parse` SyntaxError | exit 0 | `warn` | nothing |
| Stdin parseable non-object (`null`, `true`, `false`, `[]`, number, bare string) | type guards | exit 0 | `warn` "stop: stdin is not a JSON object" | nothing |
| `stop_hook_active === true` | field check (pre-consume) | exit 0 | `debug` "stop: re-entrant, skipping" | nothing |
| `session_id` missing / fails brand check | `isSessionId` false | exit 0 | `warn` "stop: invalid session_id" | nothing |
| `consumePendingCheckin` → `not_pending` | union arm | exit 0 silently (hot path) | none | nothing |
| `consumePendingCheckin` → `not_found` / `disabled` | union arm | exit 0 | `debug` | nothing |
| `consumePendingCheckin` → `timeout` | union arm | exit 0 | `warn` | nothing |
| **Outer catch (pre-consume unexpected)** | `try/catch` in `run()` | exit 0, NO notify (flag still pending) | `error` with stack | nothing this Stop; next Stop delivers |
| `ConfigParseError` / `ConfigValidationError` | `safeLoadConfig` catches | `defaultConfig()` | `warn` | fallback notification via configured method |
| `claude` ENOENT | `err.code === 'ENOENT'` | silent body | `debug` | silent body via configured method |
| `claude` timeout (8s) | child killed by timeout | silent body | `debug` | silent body |
| `claude` non-zero exit | `err.code !== 0` | silent body | `debug` with exit code + stderr | silent body |
| `claude` zero exit, stderr non-empty | zero exit + stderr content | stdout used as rawOutput | `debug` with stderr | LLM output |
| `normalizeClaudeOutput` returns `''` | `body === ''` | silent body | `debug` | silent body (tier 2) |
| `buildStats` throws | post-consume inner try | tier 3 degraded fallback | `error` "stop: post-consume unexpected throw (buildStats)" | **`"Idle check-in"` via `notify({title:'Idle', body:'Idle check-in'})`** |
| `TEMPLATES.silent(stats)` or `TEMPLATES[tone](stats)` throws | inner try | tier 3 degraded fallback | `error` "stop: post-consume unexpected throw (template)" | `"Idle check-in"` |
| `normalizeClaudeOutput(raw)` throws | inner try | tier 3 degraded fallback | `error` "stop: post-consume unexpected throw (normalize)" | `"Idle check-in"` |
| `invokeClaudeP(prompt)` throws (contract violation — it should return a union) | inner try | tier 3 degraded fallback | `error` "stop: post-consume unexpected throw (invoke)" | `"Idle check-in"` |
| **Inner catch (any other post-consume unexpected)** | `try/catch` around all post-consume work | tier 3 degraded fallback | `error` with stack | `"Idle check-in"` — **no silent loss** |

`notify()` itself never throws (CLAUDE.md contract); omitted from the matrix. If the P-1 `notify()` extension ever breaks that contract, the inner catch's final `notify()` call may itself throw; that propagates to the outer catch which logs and exits without further recovery (bounded by the contract).

## 7. Test matrix

Three layers. Each module tested at its own seam.

### 7a. Hook-level tests (`tests/hooks/stop.test.ts`)

Drive `run(input: string)` directly. Mock `invokeClaudeP` via `vi.mock('../../src/hooks/invoke-claude-p.js', …)` — a real ESM import seam now that the helper lives in its own module. `normalizeClaudeOutput` is left unmocked in most tests so the full normalize pipeline runs against canned subprocess outputs; one dedicated hook-level row mocks the normalize module with a throwing implementation to prove the inner catch's tier-3 fallback fires for *both* new seams, not just `invokeClaudeP`.

| Test name | Input (stdin / state / config) | Expected (exit / notify args / state) | Seam |
|---|---|---|---|
| `not_pending short-circuit` | valid stdin, no `pending_checkin` | exit 0, no notify | none |
| `invalid session_id` | empty `session_id` | exit 0, no state read, warn log | none |
| `stop_hook_active guard` | `stop_hook_active: true` | exit 0, no `consumePendingCheckin`, no notify | none |
| `silent preset short-circuits claude call` | tone=silent | exit 0, body = `"<m>m / <n> tool calls"`, `invokeClaudeP` NOT called | `invokeClaudeP` mock throws if called |
| `dry / earnest / absurdist happy path` (3 rows) | tone=preset | exit 0, body = normalized LLM output | `invokeClaudeP` → `{ok:true, rawOutput:'Go stretch.'}` |
| `notify forwards sound` | silent, sound=true | notify called with `sound: true` | none |
| `notify forwards method` | silent, method='terminal' | notify called with `method: 'terminal'` | none |
| `notify forwards sound + method on LLM success` | dry, sound=true, method='both' | notify called with both | `invokeClaudeP` → `{ok:true, rawOutput:'Go.'}` |
| `notify forwards sound + method on fallback` | dry, sound=true, method='terminal', timeout | same forwarding, silent body | `invokeClaudeP` → `{ok:false, reason:'timeout'}` |
| `claude timeout / ENOENT / nonzero falls back` (3 rows) | dry | silent body, debug log with reason | each mocked reason |
| `empty-after-normalize falls back` | dry | silent body, debug log | `invokeClaudeP` → `{ok:true, rawOutput:'   \n\n '}` |
| `ConfigValidationError → defaults, still notifies` | invalid config.toml | exit 0, notify called with valid body | `invokeClaudeP` canned output |
| `consumePendingCheckin reason=not_found / disabled / timeout` (3 rows) | forced cause | exit 0, no notify | none |
| `malformed stdin: empty / partial / null / true / [] / number` (6 rows) | each | exit 0, warn log, no state read | none |
| **`post-consume unexpected throw from invokeClaudeP → degraded notify`** | tone=dry, force `invokeClaudeP` mock to throw (not return union) | exit 0, error log, `notify({title:'Idle', body:'Idle check-in'})` (tier 3) | `invokeClaudeP` mock throws synchronous Error |
| **`post-consume unexpected throw from normalizeClaudeOutput → degraded notify`** | tone=dry, `invokeClaudeP` returns ok but `normalizeClaudeOutput` mock throws | exit 0, error log, tier-3 degraded notify | `vi.mock('../../src/hooks/normalize-claude-output.js')` with a throwing impl |
| **`pre-consume unexpected throw → NO notify, no flag clear`** | force `consumePendingCheckin` to throw (e.g., mock `state.ts`) | exit 0, error log, `notify` NOT called | mock `consumePendingCheckin` throws |
| `no stdout` | any happy path | `process.stdout.write` spy records zero bytes | spy |
| `notify is awaited` | any happy path | `run()` resolves only after `notify` resolves | gated notify mock |

### 7b. `normalizeClaudeOutput` unit tests (`tests/hooks/normalize-claude-output.test.ts`)

Pure function. No mocks.

| Test | Input | Expected |
|---|---|---|
| empty → empty | `''` | `''` |
| whitespace only → empty | `'   \n\n  '` | `''` |
| ANSI only → empty | `'\x1b[31m\x1b[0m'` | `''` |
| single line, trimmed | `'  Go stretch.  '` | `'Go stretch.'` |
| multi-line → first non-empty | `'\n\nGo stretch.\nSecond.\n'` | `'Go stretch.'` |
| ANSI codes stripped | `'\x1b[31mgo\x1b[0m for a walk'` | `'go for a walk'` |
| ANSI mid-line with multi-line | `'\n\x1b[32mFirst.\x1b[0m\nSecond.'` | `'First.'` |
| exactly 200 → pass through | 200-char string | same, 200 chars |
| 201 → capped to 200 | 201-char string | first 200 |
| 500 → capped to 200 | 500-char string | `.length === 200` |

### 7c. `invokeClaudeP` tests (`tests/hooks/invoke-claude-p.test.ts`)

Single test file, two describe blocks. Unit tests give fast feedback on wrapper logic; integration tests validate real `execFile` behavior that mocks can't fake (timeout firings, ENOENT error shape, signal kills). **Both** levels are kept — the fast-feedback loop AND the real-behavior validation.

#### 7c.i UNIT — module-mock (`vi.mock('node:child_process', …)` at file top)

Matches the existing `tests/core/notify.test.ts` pattern. Validates argument construction, happy-path shape, error categorization mapping. Does NOT validate real timeout / ENOENT / signal behavior.

| Test | Mock behavior | Expected |
|---|---|---|
| `argv shape` | verify `execFile('claude', ['-p', <prompt>], …)` exactly | argv assertion |
| `options carry timeout: 8_000, maxBuffer: 64*1024, env: process.env, windowsHide: true` | option inspection | option assertion |
| `no stdout inheritance` | verify `execFile` called without `stdio:'inherit'` | option assertion |
| `prompt with shell metachars` | prompt contains backticks + `$()` + `;` | single argv entry; no shell expansion possible |
| `happy path mapping` | stdout='x', stderr='', exit 0 | `{ok:true, rawOutput:'x'}` |
| `zero-exit-with-stderr mapping` | stdout='ok', stderr='warn', exit 0 | `{ok:true, rawOutput:'ok'}`; stderr logged at debug |
| `nonzero mapping` | err with `code=1` | `{ok:false, reason:'nonzero'}` |
| `ENOENT mapping` | err with `code='ENOENT'` | `{ok:false, reason:'enoent'}` |
| `timeout mapping` | err with `killed=true, signal='SIGTERM'` | `{ok:false, reason:'timeout'}` |
| `other-signal mapping` | err with `signal='SIGKILL'` (not from timeout) | `{ok:false, reason:'killed'}` |

#### 7c.ii INTEGRATION — real `execFile` against `tests/fixtures/fake-claude-p.mjs`

No `node:child_process` mocking. Tests import `execClaudeLike` and invoke it against the fixture script as `execClaudeLike(process.execPath, [fixturePath, ...flags], timeoutMs)`. This validates the real mapping: that Node's `execFile` actually produces the error shapes the unit tests synthesized; that timeout SIGTERM is observed; that ENOENT is what the real kernel returns when the binary is missing.

Fixture `tests/fixtures/fake-claude-p.mjs` flags: `--stdout <text>`, `--stderr <text>`, `--exit <N>` (default 0), `--sleep-ms <N>` (default 0). Written as a Node `.mjs` (not a shell script) so Windows CI can eventually run it unchanged.

| Test | Fixture invocation | Expected `ClaudeResult` |
|---|---|---|
| `happy path` | `--stdout "Go stretch.\n" --exit 0`, timeout 2_000 | `{ok:true, rawOutput:'Go stretch.\n'}` |
| `timeout` | `--sleep-ms 3000 --stdout "late"`, timeout 500 | `{ok:false, reason:'timeout'}` |
| `ENOENT` | `execClaudeLike('/definitely/not/a/binary', [], 2_000)` | `{ok:false, reason:'enoent'}` |
| `non-zero exit` | `--stderr "boom" --exit 1`, timeout 2_000 | `{ok:false, reason:'nonzero'}`; stderr observable in debug log |
| `stderr with zero exit` | `--stderr "DeprecationWarning" --stdout "ok" --exit 0`, timeout 2_000 | `{ok:true, rawOutput:'ok'}`; stderr logged at debug |
| `killed signal` | fixture sleeps; test sends SIGKILL to the child mid-run via `child.kill('SIGKILL')` (test grabs handle through a small helper hook, or uses a longer `--sleep-ms` and `execFileP`'s own pid) | `{ok:false, reason:'killed'}` |

## 8. Open questions

None. Prior-round concerns resolved: `IDLE_CLAUDE_BINARY` is not added (integration tests call `execClaudeLike(process.execPath, [fixturePath, …], timeoutMs)` directly; `execClaudeLike` is module-local, not used by the production hook). Degraded-fallback body is the literal `"Idle check-in"` with notify opts `{title:'Idle', body:'Idle check-in'}` — no sound/method forwarded in this tier because config may not have loaded. `[INNER TRY]` boundary starts immediately after `consumePendingCheckin` success, wrapping every post-consume step through the final `notify`.

Anything surfaced during Phase 2 goes in the implementation PR, not this doc.
