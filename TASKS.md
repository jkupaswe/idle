# TASKS.md — Idle build task graph

This document defines the agent fleet, the ticket dependency graph, and individual ticket specs. It is the source of truth for who works on what.

## Agent fleet

### Agent 1: Architect (Opus 4.7)

**Role:** Owns package setup, project structure, cross-cutting types, CI config. Writes the foundational files that everyone else builds on. Reviews final integration.

**Owned files:**
- `package.json`, `tsconfig.json`, `.gitignore`, `.npmignore`
- `src/lib/types.ts`, `src/lib/paths.ts`, `src/lib/log.ts`
- `.github/workflows/ci.yml`
- `LICENSE` (MIT)

**Tickets:** T-001, T-002, T-003, T-020 (final integration review)

---

### Agent 2: Core Implementer (Sonnet 4.6)

**Role:** Owns the `src/core/` module — config loading, state management, settings.json manipulation, notifications. This is the heart of the tool.

**Owned files:**
- `src/core/config.ts`
- `src/core/state.ts`
- `src/core/settings.ts`
- `src/core/notify.ts`
- Tests for all of the above in `tests/core/`

**Tickets:** T-004, T-005, T-006, T-007

---

### Agent 3: Hooks Implementer (Sonnet 4.6)

**Role:** Owns the four hook scripts that Claude Code invokes. These read JSON from stdin, update state, and (for Stop) emit prompt-hook JSON output.

**Owned files:**
- `src/hooks/session-start.ts`
- `src/hooks/post-tool-use.ts`
- `src/hooks/stop.ts`
- `src/hooks/session-end.ts`
- `src/prompts/dry.ts`, `earnest.ts`, `absurdist.ts`, `silent.ts`
- Tests in `tests/hooks/`
- Fixtures in `tests/fixtures/`

**Tickets:** T-008, T-009, T-010, T-011, T-012

---

### Agent 4: CLI Implementer (Sonnet 4.6)

**Role:** Owns the `src/cli.ts` entry point and all `src/commands/*` files. Builds the user-facing command surface.

**Owned files:**
- `bin/idle`
- `src/cli.ts`
- `src/commands/init.ts`, `install.ts`, `uninstall.ts`, `stats.ts`, `disable.ts`, `enable.ts`, `status.ts`, `doctor.ts`
- Tests in `tests/commands/`

**Tickets:** T-013, T-014, T-015, T-016, T-017

---

### Agent 5: Docs & Polish (Haiku 4.5)

**Role:** Writes README, contributing guide, issue templates. Reviews CLI output and error messages for voice consistency. Writes the final launch-ready README.

**Owned files:**
- `README.md`
- `CONTRIBUTING.md`
- `.github/ISSUE_TEMPLATE/*`
- `.github/PULL_REQUEST_TEMPLATE.md`

**Tickets:** T-018, T-019

---

### Agent 6: Reviewer (Opus 4.7)

**Role:** No files owned. Reviews every PR from other agents against the PRD acceptance criteria and CLAUDE.md rules. Has authority to request changes before merge. Focuses on: voice consistency, safety rules (atomic writes, backups), and PRD alignment.

**Tickets:** Reviews all PRs; does not write code.

---

## Established architecture landmarks

These decisions are settled across Core Wave 2 and apply to all remaining tickets. They are documented here and in CLAUDE.md. Tickets below assume these as baseline; do not re-decide them during implementation.

- **Shipping model:** Idle ships TypeScript sources. Hooks execute via `npx tsx`. No compiled `dist/` at runtime. Installed command format: `npx tsx /abs/path/src/hooks/<n>.ts # idle:v1`.
- **Hook ownership:** Strict three-condition `isIdleOwnedCommand` predicate in `src/core/settings.ts`. No substring matching.
- **Async hook flags:** SessionStart/PostToolUse/SessionEnd are `async: true`; Stop is sync.
- **Never-throw primitives:** `log()` and `notify()` contractually never throw. Callers do not wrap.
- **State access:** Use named helpers in `src/core/state.ts` (readState, registerSession, removeSession, takeSessionSnapshot, consumePendingCheckin, incrementToolCounter). Raw `_updateState` is module-private.
- **Settings access:** Use `installHooks()` / `uninstallHooks()` from `src/core/settings.ts`. Both return discriminated-result types.
- **Config access:** Use `loadConfig()` (strict, throws on schema violation), `saveConfig()` (creates directory as needed), `validateConfig()`. Error classes are `ConfigParseError`, `ConfigValidationError`.
- **Filesystem safety:** Use `writeAllSync` and `atomicWriteFile` from `src/lib/fs.ts`. Never raw `fs.writeSync` on user files.
- **Time formatting:** Use `nowIso()` and `timestampSuffix()` from `src/lib/time.ts`.

---

## Dependency graph

```
           T-001 (package/tsconfig)
                  │
        ┌─────────┼─────────┐
        ▼         ▼         ▼
     T-002    T-003      (blocks all below)
     (types) (paths/log)
        │
        └────────┬─────────┬──────────┬─────────┐
                 ▼         ▼          ▼         ▼
              T-004     T-005      T-006      T-007
              config    state    settings    notify
                 │        │          │         │
                 └────────┼──────────┴─────────┘
                          │
              ┌───────────┼───────────┬──────────┐
              ▼           ▼           ▼          ▼
            T-008       T-009       T-010      T-011
         session-      post-       stop       session-
          start       tool-use    (prompt)     end
                          │
                          ▼
                        T-012
                      (prompt
                      templates)
                          │
              ┌───────────┼───────────┬──────────┬─────────┐
              ▼           ▼           ▼          ▼         ▼
            T-013       T-014       T-015      T-016     T-017
           cli.ts     install/    stats/    doctor    bin/idle
                      uninstall   status/   
                                  enable/
                                  disable
                          │
                          └───────────┬─────────┐
                                      ▼         ▼
                                    T-018     T-019
                                    README    CONTRIBUTING
                                      │
                                      ▼
                                    T-020
                                 integration
                                   review
```

**Parallelization:** T-004 through T-007 run in parallel (one agent, four PRs, or split across agents). T-008 through T-011 run in parallel. T-013 through T-017 run in parallel. This gives you roughly 4 waves of parallel work.

---

## Tickets

### T-001: Project scaffold (Architect)

**Depends on:** nothing
**Files:** `package.json`, `tsconfig.json`, `.gitignore`, `.npmignore`, `LICENSE`

**Description:** Initialize the Node/TS project. Set up strict TypeScript, ESM, Node 20+ engine requirement, and the dependency list from PRD §8.

**Acceptance:**
- `npm install` succeeds on a clean checkout.
- `npx tsc --noEmit` passes.
- `package.json` declares `"type": "module"`, `"bin": { "idle": "./bin/idle" }`, and engines `>=20`.
- Dev dependencies: `typescript`, `tsx`, `vitest`, `@types/node`.
- Runtime dependencies: `commander`, `@iarna/toml`, `prompts`, `chalk`, `proper-lockfile`.
- `.gitignore` excludes `node_modules`, `dist`, `.idle-test-home`.
- MIT LICENSE file with Justin's attribution placeholder.

---

### T-002: Shared types (Architect)

**Depends on:** T-001
**Files:** `src/lib/types.ts`

**Description:** Define TypeScript types for: Claude Code hook payloads (SessionStart, PostToolUse, Stop, SessionEnd input shapes), Idle config shape, state shape, tone presets enum.

**Acceptance:**
- All hook payload types match the current Claude Code hooks reference (https://code.claude.com/docs/en/hooks). At minimum: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, plus event-specific fields (`tool_name`, `tool_input`, `tool_response` for PostToolUse).
- `IdleConfig` type covers every field in PRD §6.2.
- `SessionState` type covers every field in PRD §6.3.
- `TonePreset` is a string union: `"dry" | "earnest" | "absurdist" | "silent"`.
- Types are exported named (not default), fully documented with JSDoc.

---

### T-003: Path resolution + debug logging (Architect)

**Depends on:** T-001
**Files:** `src/lib/paths.ts`, `src/lib/log.ts`

**Description:** Centralize all filesystem paths and debug logging.

**Acceptance:**
- `paths.ts` exports: `idleHome()` → `~/.idle`, `idleConfigPath()`, `idleStatePath()`, `idleSessionsDir()`, `idleDebugLog()`, `claudeHome()` → `~/.claude`, `claudeSettingsPath()`.
- All paths use `os.homedir()`; no hardcoded `/Users/` or `/home/`.
- `IDLE_HOME` env var override supported for testing (if set, all paths rebase from it).
- `log.ts` exports a `log(level, msg, meta?)` function that appends JSON lines to `~/.idle/debug.log`. Never throws; failures to write silently swallowed. Levels: `debug`, `info`, `warn`, `error`.

---

### T-004: Config load/save (Core)

**Depends on:** T-002, T-003
**Files:** `src/core/config.ts`, `tests/core/config.test.ts`

**Description:** Load and save `~/.idle/config.toml`. Provide a default-config factory and validation.

**Acceptance:**
- `loadConfig()` reads the TOML file, applies defaults for missing keys, returns `IdleConfig`.
- `saveConfig(config)` atomically writes TOML (temp file, rename).
- `defaultConfig()` returns a valid `IdleConfig` with: `thresholds: { time_minutes: 45, tool_calls: 40 }`, `tone.preset: "dry"`, `notifications.method: "native"`, `projects: {}`.
- `loadConfig()` returns defaults if file doesn't exist; does NOT create it.
- Invalid TOML raises a descriptive error with the file path.
- `validateConfig(config)` returns either `{ valid: true }` or `{ valid: false, errors: string[] }`.
- Tests cover: load missing file → defaults, load valid file, load invalid TOML, save round-trip, validation of invalid values.

---

### T-005: State atomic read/write (Core)

**Depends on:** T-002, T-003
**Files:** `src/core/state.ts`, `tests/core/state.test.ts`

**Description:** Read and write `~/.idle/state.json` safely under concurrent access. Multiple hooks may fire at once.

**Acceptance:**
- `readState()` returns `SessionState`. Creates `{sessions: {}}` if file missing.
- `updateState(mutator: (state) => void)` acquires file lock, reads, applies mutator, writes atomically, releases lock. Uses `proper-lockfile`.
- Lock timeout: 5 seconds. On timeout, log and throw.
- Atomic write: write to `state.json.tmp`, fsync, rename.
- Corrupted JSON: log error, back up corrupted file to `state.json.corrupt-<ts>`, start fresh with `{sessions: {}}`.
- Tests: concurrent `updateState` calls from child processes (use vitest's `test.concurrent`), corruption recovery, lock contention.

---

### T-006: Settings.json merge/unmerge (Core)

**Depends on:** T-002, T-003
**Files:** `src/core/settings.ts`, `tests/core/settings.test.ts`

**Description:** Safely add and remove Idle's hook entries in the user's `~/.claude/settings.json`, preserving all other keys and hooks.

**Acceptance:**
- `installHooks()` reads settings.json (or `{}` if missing), adds the four Idle hook entries tagged with `# idle:v1` markers in the command strings, writes atomically with a timestamped backup.
- `uninstallHooks()` reads settings.json, removes any hook whose command contains `# idle:v1`, writes atomically. If a matcher group becomes empty after removal, remove the group.
- Hook entries follow the Claude Code schema: `{"type": "command", "command": "npx tsx <abs-path>/hooks/session-start.ts # idle:v1"}` etc. for each event.
- Backup path: `~/.claude/settings.json.idle-backup-<ISO-ts>`.
- `settingsPath` is the full path, overridable via `IDLE_CLAUDE_SETTINGS_PATH` env for tests.
- Tests verify byte-identical round-trip: given an arbitrary pre-existing settings.json, `install` then `uninstall` produces a file identical to the original (modulo whitespace if JSON pretty-print differs — normalize with `JSON.stringify` roundtrip).
- Tests verify install is idempotent: running `install` twice produces the same result as running it once.
- Tests verify install preserves user's existing hooks and MCP servers.

---

### T-007: Cross-platform notifications (Core)

**Depends on:** T-002, T-003
**Files:** `src/core/notify.ts`, `tests/core/notify.test.ts`

**Description:** Trigger a native OS notification with a title and body.

**Acceptance:**
- `notify({ title, body, sound? })` returns a Promise.
- On macOS (detected via `process.platform === 'darwin'`): shell out to `osascript -e 'display notification "..." with title "..."'`. Escape special characters.
- On Linux: shell out to `notify-send "title" "body"`. Detect presence via `which notify-send`; if absent, log warning and fall back to stderr print.
- On other platforms (e.g. Windows in v2): fall back to stderr print.
- Notification failures are logged but do not throw — they should not break Claude Code sessions.
- Tests: mock `child_process.exec`, verify correct command per platform, verify escaping of quotes and special chars in body.

---

### T-008: SessionStart hook (Hooks)

**Depends on:** T-004, T-005
**Files:** `src/hooks/session-start.ts`, `tests/hooks/session-start.test.ts`, `tests/fixtures/session-start-*.json`

**Description:** Hook script that runs at session start. Reads JSON from stdin, initializes session state.

#### Architectural landmarks for this ticket

- This hook is configured with `async: true` in settings.json (per established landmarks). The script may do brief I/O without user-visible latency concerns, but should still be efficient.
- **Use `registerSession(id, entry, options?)` from `src/core/state.ts`. Caller constructs the full `SessionEntry` — see `src/lib/types.ts`. Do NOT import or use `_updateState` (module-private).**
- **Use `log()` for warnings and info, not `console.log`.** Claude Code captures stdout.

#### Acceptance criteria

- Reads full stdin as JSON. Parses `session_id` and `cwd` using the Claude Code payload types from `src/lib/types.ts`.
- Validates `session_id` via `isSessionId` before use. If invalid, log and exit 0 (do not crash the session).
- Validates `cwd` via `isAbsolutePath` / `asAbsolutePath`. If invalid, log and exit 0.
- Calls `registerSession(sessionId, cwd, disabled)` where `disabled` is determined by checking config's per-project override for `cwd`.
- Exits 0 on success. Exits 0 with debug-logged warning on any non-fatal issue.
- Never outputs anything to stdout.
- Test: feed fixtures, assert state changes via `readState`, assert exits 0, assert no stdout, assert debug log entries on invalid input.

#### What NOT to do

- Do not implement session entry creation by hand via raw state access.
- Do not log to stdout or stderr directly — use `log()`.
- Do not throw on malformed input — log and exit 0.

---

### T-009: PostToolUse hook (Hooks)

**Depends on:** T-004, T-005
**Files:** `src/hooks/post-tool-use.ts`, `tests/hooks/post-tool-use.test.ts`, `tests/fixtures/post-tool-use-*.json`

**Description:** Fires after every tool call. Increments counters via the fail-open counter helper.

#### Architectural landmarks for this ticket

- This is the hot path. PRD §7 mandates `<50ms` added latency. The hook is configured `async: true`, which means Claude Code will not block on it, but the hook itself must still be efficient.
- **Use `incrementToolCounter(sessionId, tool, thresholds)` from `src/core/state.ts`. This helper is already fail-open with a 200ms default timeout; do not override the timeout unless you have a specific reason and document it in a comment.**
- **Do NOT call `readState` + manual mutation.** That bypasses the atomicity guarantees and creates race conditions.
- **Subagent tool calls are out of scope for v1 per F-003.** Pass `{ name, summary }` only to `incrementToolCounter`. The `agent_id` field in the PostToolUse payload is ignored by this hook in v1. Do NOT attempt to pass an `isSubagent` flag — `ToolCall` does not accept it.

#### Acceptance criteria

- Reads stdin JSON, extracts `session_id`, `tool_name`, and `tool_input`.
- Tool input summary: truncated to exactly 200 chars (not "reasonable" — exactly 200).
- Load config via `loadConfig()` once per hook invocation. Extract thresholds.
- Call `incrementToolCounter(sessionId, { name, summary }, thresholds)`. Handle the result:
  - `{ ok: true, thresholdTripped: true }`: the helper has already flagged `pending_checkin`; nothing more to do here.
  - `{ ok: true, thresholdTripped: false }`: also nothing more to do.
  - `{ ok: false, reason: 'timeout' }`: log warn and exit 0 (fail-open — this is the hot-path guarantee).
  - `{ ok: false, reason: 'disabled' | 'not_found' }`: log debug and exit 0.
- Exits 0. No stdout. Must complete in <50ms typical via the fail-open timeout.

#### What NOT to do

- Do not bypass `incrementToolCounter` by reading state and mutating directly.
- Do not extend the timeout beyond the helper's default without explicit justification.
- Do not block on any I/O other than the state update.

---

### T-010: Stop hook with prompt output (Hooks)

**Depends on:** T-004, T-005, T-007, T-012
**Files:** `src/hooks/stop.ts`, `src/hooks/invoke-claude-p.ts`, `src/hooks/normalize-claude-output.ts`, `tests/hooks/stop.test.ts`, `tests/hooks/invoke-claude-p.test.ts`, `tests/hooks/normalize-claude-output.test.ts`, `tests/fixtures/stop-*.json`, `tests/fixtures/fake-claude-p.mjs`

**Description:** Fires when the agent stops responding. If a check-in is pending, generates a break suggestion via `claude -p` and triggers a native notification.

#### Required: design doc before implementation

**This ticket has enough architectural complexity that the agent MUST produce a one-page design doc before writing code. Post it as a PR draft or inline in the PR description.** The design doc covers:

- Proposed entry-point structure (main function + helpers)
- Exact `claude -p` invocation pattern (see below for the settled decisions)
- Prompt construction: how template selection works, how stats are filled in
- Timeout handling, fallback path
- Error handling at each boundary
- Test matrix

Reviewer approves the design, then implementation proceeds.

#### Architectural landmarks for this ticket

This ticket composes several established primitives. The specific composition is:

1. **Child process invocation:** Use `child_process.execFile('claude', ['-p', prompt], options)` — **NOT `spawn` or `exec`**. `execFile` prevents shell injection when the prompt contains shell metacharacters (which LLM-generated content can).
2. **Auth inheritance:** The spawned `claude` process inherits the user's environment. Pass `env: process.env` explicitly and set `timeout: 8000` (8 seconds) in the `execFile` options. Reasoning: Stop is `async: false`, so the `execFile` timeout is the worst-case user-visible block before the next prompt starts. `claude -p` for a 30-word output typically resolves in 2–5 seconds; 8s leaves headroom, and timeout firings gracefully fall back to the silent-preset body so the user still gets a signal. (Earlier iterations of this ticket specified 15s; reduced to 8s via the T-010 design doc.)
3. **State reset:** Use `consumePendingCheckin(sessionId)` from `src/core/state.ts`. This helper is atomic and race-safe. Do NOT manually read state, clear the `pending_checkin` flag, and write back — that reintroduces the race the helper was built to solve.
4. **Notification:** Use `notify({ title, body, sound, method })` from `src/core/notify.ts`, forwarding `config.notifications.sound` and `config.notifications.method` on **every** call site (silent-preset success, LLM success, and every fallback). `notify()` is never-throw; do not wrap in try/catch. **Prerequisite:** `notify()` currently only accepts `sound`. Extending `NotifyInput` to accept `method` is a Core-owned change that must land before T-010 implementation starts; tracked in the T-010 design doc under "Prerequisites".
5. **Prompt templates:** Load from `src/prompts/<tone>.ts` based on the configured tone preset. Each template exports a `buildPrompt(stats)` function (per T-012).
6. **Silent preset:** If `config.tone.preset === 'silent'`, skip the `claude -p` call entirely and pass the template's direct output string to `notify()`.
7. **Shipping model:** The hook is invoked as `npx tsx src/hooks/stop.ts # idle:v1`. Do not assume any compiled artifact exists.

#### Flow (for the design doc to elaborate)

1. Read stdin JSON, extract `session_id` and any other relevant fields.
2. Validate `session_id` via `isSessionId`. On failure, log and exit 0.
3. Call `consumePendingCheckin(sessionId)`. Handle the discriminated result:
   - `{ ok: true, entry, cleared: true }`: proceed to step 4.
   - `{ ok: false, reason: 'not_pending' | 'not_found' | 'disabled' }`: exit 0 silently (no check-in needed).
4. Load config. Select tone preset.
5. Build prompt using `buildPrompt(stats)` from the selected template.
6. If tone is `silent`: pass the template's output directly to `notify()`. Done.
7. Otherwise: invoke `execFile('claude', ['-p', prompt], { env, timeout: 8000 })`. Capture stdout.
8. Normalize stdout (strip ANSI, trim, first non-empty line, cap at 200 chars). Pass to `notify({ title: 'Idle', body: normalizedOutput, sound, method })`, forwarding `config.notifications.sound` and `config.notifications.method`.
9. On any **hard** failure in step 7 — timeout, ENOENT (binary not on PATH), or non-zero exit — fall back to the silent preset's output. Log the failure to debug. Pass fallback to `notify()` with the same sound/method. **Zero-exit with stderr content is NOT a hard failure**: log the stderr at debug, but use stdout as success. CLI tools commonly emit stderr during normal operation (deprecation warnings, info logs); treating any stderr as failure would cause near-universal fallback. An empty-after-normalize result also falls back to the silent body.
10. Return (hook completes).

#### Acceptance criteria

- Design doc posted before implementation and approved.
- Stop hook is configured with `async: false` in settings.json (per established landmarks — it must complete before the session truly ends, so the notification appears at the right moment).
- All state mutation goes through `consumePendingCheckin`. No raw state access.
- `execFile` used (not `spawn`, not `exec`). 8-second timeout. Env inherited.
- Silent preset short-circuits the LLM call.
- Fallback path: `claude -p` hard failure (timeout, ENOENT, non-zero exit) triggers silent-preset output, logs to debug, still calls `notify()` with the configured sound/method so the user gets *some* signal. Zero-exit-with-stderr is NOT a hard failure; stdout is used, stderr is logged at debug.
- `config.notifications.sound` and `config.notifications.method` are forwarded to every `notify()` call (prereq: `NotifyInput` extended in `src/core/notify.ts`).
- Subprocess concern and output normalization live in two separate **modules** (`src/hooks/invoke-claude-p.ts` and `src/hooks/normalize-claude-output.ts`) so each has a real ESM import seam for mocking and the pure transforms are unit-testable without any subprocess involvement.
- Post-consume error paths notify rather than exiting silently, so an unexpected bug downstream of `consumePendingCheckin` cannot drop a user-visible check-in. Known-failure paths (invokeClaudeP non-ok, normalize-empty) use the silent-preset body; the inner catch uses a degraded body `"Idle check-in"` that depends on no post-consume state. Pre-consume unexpected exceptions still exit without notifying (pending flag uncleared; next Stop delivers).
- Tests cover: happy path with mocked `invokeClaudeP`, timeout, non-zero exit, ENOENT, empty-after-normalize, silent preset, not-pending short-circuit, invalid session_id, malformed stdin sub-cases, `stop_hook_active` re-entrancy guard, sound+method forwarding on every call site, ANSI stripping, the 200-char cap, and both the `invokeClaudeP`-throws and `normalizeClaudeOutput`-throws post-consume degraded-fallback paths. `normalizeClaudeOutput` has a dedicated pure-function unit test suite. `invokeClaudeP`'s test file has a **UNIT** describe block that mocks `node:child_process` (argv, options, error-shape mapping) and an **INTEGRATION** describe block that exercises real `execFile` against `tests/fixtures/fake-claude-p.mjs` (happy path, real timeout, real ENOENT against a missing binary, non-zero exit, stderr-with-zero-exit, killed signal).
- Must complete in reasonable time under normal conditions. An 8s `claude -p` call is the worst case; beyond that, the timeout fires and the fallback is used.

#### What NOT to do

- Do not use `spawn` or `exec`. Shell injection is a real risk with LLM-generated content.
- Do not manually manage `pending_checkin`. Use the helper.
- Do not wrap `notify()` or `log()` in try/catch. They are never-throw.
- Do not introduce a two-hook design (earlier PRD iterations referenced this; it is superseded).
- Do not write the prompt to a temp file unless you have a specific reason and document why.

---

### T-011: SessionEnd hook (Hooks)

**Depends on:** T-004, T-005
**Files:** `src/hooks/session-end.ts`, `tests/hooks/session-end.test.ts`

**Description:** Fires at session end. Writes summary to disk, removes session from live state.

#### Architectural landmarks for this ticket

- This hook is configured with `async: true` in settings.json.
- **Use `takeSessionSnapshot(sessionId)` and `removeSession(sessionId)` from `src/core/state.ts`.** Do NOT use raw state access.
- **Use `atomicWriteFile` from `src/lib/fs.ts`** to write the summary file. Do not use raw `fs.writeFileSync`.

#### Acceptance criteria

- Reads stdin JSON, extracts `session_id`.
- Calls `takeSessionSnapshot(sessionId)`:
  - `{ ok: true, snapshot }`: write snapshot to `~/.idle/sessions/<session_id>.json` via `atomicWriteFile`, then call `removeSession(sessionId)`.
  - `{ ok: false, reason: 'not_found' }`: log debug, exit 0.
- Exits 0. No stdout.
- Tests: fixture round-trip, verify summary file created (byte-identical to snapshot), verify state entry removed.

#### What NOT to do

- Do not use raw `fs.writeFileSync` for the summary file.
- Do not call `readState` + manual deletion.

---

### T-012: Tone prompt templates (Hooks)

**Depends on:** T-002
**Files:** `src/prompts/dry.ts`, `earnest.ts`, `absurdist.ts`, `silent.ts`

**Description:** One file per tone preset. Exports a `buildPrompt(stats: CheckInStats): string` function that returns the filled-in prompt to pass to `claude -p`. For the `silent` preset, returns a bare stats string (no LLM call — Stop hook short-circuits on tone="silent").

**Acceptance:**
- Each template takes stats (duration, tool_calls, last_tool_name, last_tool_summary) and returns a complete prompt.
- Each template encodes its voice via specific phrasing, example outputs, and instructions in the prompt.
- `silent.ts` exports the same signature but returns the notification body directly (e.g. `"47m / 32 tool calls"`) — Stop hook detects `tone === "silent"` and skips the LLM call, passing this string straight to `notify()`.
- Templates are short (<40 lines each).
- No template ever asks the model to produce more than one sentence.

---

### T-013: CLI entry point (CLI)

**Depends on:** T-002, T-003
**Files:** `src/cli.ts`, `bin/idle`

**Description:** Main CLI dispatcher using `commander`. Registers all subcommands. Prints top-level help.

#### Architectural landmarks for this ticket

- **Shipping model:** `bin/idle` must work without a build step. Two acceptable patterns:
  - Pattern A (preferred): `#!/usr/bin/env -S npx tsx` shebang, dispatching directly to `src/cli.ts`. Simple but slightly slow on cold start.
  - Pattern B: Small JS shim that `require()`s `tsx` and dispatches. More robust across environments.
  - **Pattern B is what we'll use.** It avoids `env -S` portability concerns and gives cleaner error messages if `tsx` is missing.
- **Do not produce a `dist/cli.js`.** There is no build step. The `bin/idle` JS shim is the entry point; `src/cli.ts` is the actual code.

#### Acceptance criteria

- `bin/idle` is a JS file (not TS): starts with `#!/usr/bin/env node`, registers `tsx` via `require('tsx/cjs')` or equivalent modern pattern, then imports/runs `src/cli.ts`.
- `bin/idle` is marked executable (`chmod +x`) either via a postinstall script or by committing it with the executable bit set.
- `idle --help` lists all subcommands with one-line descriptions matching the Idle voice.
- `idle --version` prints package version from `package.json`.
- Subcommands not yet implemented stub to a "not implemented" error with exit code 1.
- Subcommands route to files in `src/commands/`, not inlined in `src/cli.ts`.

#### What NOT to do

- Do not introduce a build step or compilation target.
- Do not inline subcommand logic in `cli.ts`.

---

### T-014: init, install, uninstall commands (CLI)

**Depends on:** T-004, T-006, T-013
**Files:** `src/commands/init.ts`, `src/commands/install.ts`, `src/commands/uninstall.ts`, tests

**Description:** Three commands that together handle the install lifecycle. This ticket also resolves follow-up **F-001** (package.json / bin / tarball-shape).

#### Architectural landmarks for this ticket

- **Shipping model:** Installing hooks means calling `installHooks()` from `src/core/settings.ts`. That helper already handles file locking, atomic writes, backups, and `isIdleOwnedCommand` invariants. Do not replicate any of that logic.
- **The `bin/idle` entry point and `package.json` "bin" field are restored in this ticket (F-001).** Concretely:
  - `bin/idle` JS shim is created (per T-013's pattern — they may be done together).
  - `package.json` has `"bin": { "idle": "./bin/idle" }`.
  - `package.json` `files` allowlist includes `bin`, `src`, `README.md`, `LICENSE`.
  - A new test file `tests/core/package.test.ts` asserts that `npm pack --dry-run` output includes every path referenced in `package.json`'s `bin`, `main`, `exports`, and `files` fields. This test runs in CI going forward.
- **Install and uninstall results:** `installHooks()` and `uninstallHooks()` return discriminated-result types. The CLI commands pattern-match on these and print user-facing messages matching the Idle voice:
  - `installHooks()` success with `backupPath`: "Installed. Previous settings backed up to \<path\>."
  - `installHooks()` success with `backupPath: null`: "Installed."
  - `installHooks()` failure with `reason: 'claude_not_installed'`: "Claude Code not found. Install it first: \<URL\>."
  - `installHooks()` failure with `reason: 'permission_denied'`: "Cannot write to ~/.claude/settings.json: \<detail\>."
  - `uninstallHooks()` success with `fileExisted: false`: "No Claude Code settings file found; nothing to uninstall."
  - `uninstallHooks()` success with `removedEvents: []` but `fileExisted: true`: "No Idle hooks found in settings.json."
  - `uninstallHooks()` success with removed events: "Uninstalled. Previous settings backed up to \<path\>."

#### Acceptance criteria

- `idle init` interactive TUI using the `prompts` library (already in deps). Asks for: tone preset (select from 4), time threshold (number, default 45), tool call threshold (number, default 40), notification method (select from 3). Confirms before writing. On confirm: calls `saveConfig()`, then `installHooks()`. Prints result messages per above.
- `idle install [--defaults]` non-interactive equivalent.
- `idle uninstall [--purge]`: calls `uninstallHooks()`. If `--purge`, also removes `~/.idle/` directory. Prints result messages per above.
- All three refuse to run with a helpful error if `~/.claude/` is missing.
- `bin/idle` is created and executable. `package.json` bin field restored. Tarball test passes.
- Tests: spawn each command in a sandboxed `IDLE_HOME` and a sandboxed `CLAUDE_HOME`, assert files created/removed correctly, assert output strings match the voice.

#### What NOT to do

- Do not reimplement install/uninstall logic. Use `installHooks()` and `uninstallHooks()`.
- Do not introduce a build step for `bin/idle`.
- Do not use a TUI library other than `prompts`.
- Do not print cheerful or preachy messages. Match the Idle voice.

---

### T-015: stats, status, enable, disable commands (CLI)

**Depends on:** T-004, T-005, T-013
**Files:** `src/commands/stats.ts`, `status.ts`, `enable.ts`, `disable.ts`, tests

**Description:** Read-only and config-toggle commands.

#### Architectural landmarks for this ticket

- **Use `readState()` from `src/core/state.ts`.** Handle all four `ReadStateResult` variants (`fresh`, `empty`, `recovered`, `partial`) — `recovered` and `partial` should surface a user-visible note about the backup path.
- **`idle disable` and `idle enable` read `process.cwd()` and validate via `asAbsolutePath`.** If the validation throws, print a clean error — don't crash.
- **Use `loadConfig()` and `saveConfig()`** for config reads and writes. No raw TOML manipulation.

#### Acceptance criteria (existing) + these additions

- `idle stats` output handles the `partial` and `recovered` variants: "Note: N malformed session entries were backed up to \<path\>."
- `idle disable` validates `process.cwd()` is absolute before writing to config.
- `idle enable` same.
- All output matches Idle voice. No emoji. Terse table format for stats.

---

### T-016: doctor command (CLI)

**Depends on:** T-004, T-006, T-013
**Files:** `src/commands/doctor.ts`, tests

**Description:** Diagnostic command that reports health.

#### Architectural landmarks for this ticket

- **Output format:** One line per check. `[ok]` or `[fail]` prefix. No emoji. No color except dim for explanatory sub-lines. Voice: terse, diagnostic.
- Example:
  ```
  [ok]   Claude Code installed at /usr/local/bin/claude
  [ok]   ~/.claude/settings.json readable
  [ok]   Idle hooks registered (4)
  [ok]   Idle config valid
  [fail] Notification tool unavailable (notify-send not on PATH)
         Install via: sudo apt install libnotify-bin
  ```

#### Acceptance criteria (existing) + these additions

- Output format per above.
- Exit code 0 if all pass, 1 if any fail.
- Each fail message includes a specific next step.
- Tests: each check mockable independently.

---

### T-017: bin/idle + build config (CLI) — MERGED INTO T-014

**Note:** Much of T-017's original scope (creating `bin/idle`, package.json bin field, tarball shape) is now part of T-014 (F-001 resolution). T-017 shrinks to a verification ticket.

**Files:** none new

**Acceptance:**
- `npm link && idle --help` works as a manual sanity check.
- `npm pack --dry-run` tarball shape test (added in T-014) passes in CI.
- If T-014 landed these correctly, T-017 is a no-op ticket that gets closed as "subsumed by T-014."

---

### T-018: README (Docs)

**Depends on:** T-014, T-015, T-016
**Files:** `README.md`

**Description:** The README is the product's marketing. It's what gets posted to HN.

**Acceptance:**
- Opens with the one-liner: "A break timer that meters your tokens, not your minutes." (or the agreed final version)
- Sections: What it is (2-3 sentences), Install, Configure, What it does (brief examples with sample output), Privacy (zero telemetry, uses your Claude Code auth, no API keys), Uninstall, FAQ, Contributing link.
- All code blocks are real and copy-pasteable.
- Voice check: re-read against CLAUDE.md voice section. No wellness-app language. No emoji in default text. Self-aware, dry, unix-tool aesthetic.
- Under 400 lines total.
- Includes a small ASCII-art example of the notification body for readers who don't have screenshots yet.

---

### T-019: CONTRIBUTING + templates (Docs)

**Depends on:** T-018
**Files:** `CONTRIBUTING.md`, `.github/ISSUE_TEMPLATE/bug.md`, `feature.md`, `.github/PULL_REQUEST_TEMPLATE.md`

**Description:** Standard open-source contribution docs.

**Acceptance:**
- CONTRIBUTING covers: dev setup, running tests, code style (reference CLAUDE.md), PR process, voice guidelines for docs/copy contributions.
- Issue templates are terse; they don't demand a dozen fields. A bug template asks: what you ran, what happened, what you expected, OS + Node version. That's it.
- PR template asks: ticket ID (if any), summary, how you tested, any CLAUDE.md rules you think are affected.

---

### T-020: Integration review (Architect/Reviewer)

**Depends on:** all others
**Files:** none — this is a review pass

**Description:** Final integration check. After all other PRs merge, run the full acceptance criteria from PRD §10. Fix any integration gaps discovered.

**Acceptance:**
- `npm install && npm run build && npm run test` passes on a clean checkout.
- Manual run: `npm link && idle init` on a real machine, start `claude`, force thresholds low, confirm notification fires.
- `idle uninstall` restores settings.json byte-identically (diff against backup).
- `idle doctor` reports all green.
- If any ticket's acceptance criteria aren't actually met, file follow-up PRs before declaring v1 done.

---

## Follow-ups

Items filed during implementation, deferred from their original tickets.

### F-001 — Package tarball shape and bin/idle restoration
**Status:** Resolved by T-014
**Origin:** T-006 round 2 Codex review; deferred per decision; also flagged during T-007 review (not T-007 scope)
**Description:** `package.json` declared `./bin/idle` but the file didn't exist; `files` allowlist referenced paths that weren't shipping. T-014 creates `bin/idle`, restores the `bin` field, and adds a `tests/core/package.test.ts` that runs `npm pack --dry-run` and asserts all declared paths are present.

### F-002 — Consolidate writeAllSync in lib/fs.ts
**Status:** Resolved by PR #17
**Origin:** T-005 round 4; re-surfaced during T-006 review
**Description:** T-005's `state.internal.ts` has its own local `writeAllSync`; T-006 created the shared `src/lib/fs.ts` version. The T-005 version should switch to importing from `lib/fs.ts` so the two cannot drift. Small refactor, appropriate for end-of-Wave-2 polish pass.

### F-003 — Subagent tool call tracking (v2)
**Status:** Open, v2 scope
**Origin:** Surfaced during Wave 2 docs alignment; infrastructure already 
shipped in T-005 strict-types recovery but no caller populates it.
**Description:** `SessionEntry` has optional 
`subagent_tool_calls_since_checkin` and `total_subagent_tool_calls` fields; 
`incrementToolCounter`'s threshold check already sums them; 
`consumePendingCheckin` already resets them on check-in. What's missing: 
(1) `ToolCall` needs an optional `isSubagent` field, and (2) 
`incrementToolCounter` needs to conditionally increment the subagent 
counters when `isSubagent === true`. T-009 then detects `agent_id` in 
the PostToolUse payload and passes `isSubagent: true` accordingly. 
Estimated 10-20 lines of code + tests. Good v2 feature since Agent Teams 
is gaining adoption.

### F-004 — Brand `SessionEntry.project_path` as `AbsolutePath` (v1 polish)
**Status:** Open, low priority
**Origin:** Surfaced during Wave 2 docs alignment.
**Description:** `SessionEntry.project_path` is typed as `string` with a 
JSDoc comment noting it's an absolute path. Brand it as `AbsolutePath` 
so callers cannot pass a relative path. Small refactor, catches a whole 
class of potential bugs at compile time. Appropriate for end-of-Wave-2 
polish.
