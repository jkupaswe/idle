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

**Acceptance:**
- Reads full stdin as JSON. Parses `session_id` and `cwd`.
- Calls `updateState` to add a session entry: `{ started_at: now(), project_path: cwd, tool_calls_since_checkin: 0, total_tool_calls: 0, last_checkin_at: null, checkins: [] }`.
- Checks config for a per-project override; if the project is disabled, sets `disabled: true` on the session entry.
- Exits 0 on success, 0 with stderr warning on non-fatal issues.
- Never outputs anything to stdout (Claude Code uses stdout for JSON protocol).
- Test: feed fixtures, assert state changes, assert exits 0, assert no stdout.

---

### T-009: PostToolUse hook (Hooks)

**Depends on:** T-004, T-005
**Files:** `src/hooks/post-tool-use.ts`, `tests/hooks/post-tool-use.test.ts`, `tests/fixtures/post-tool-use-*.json`

**Description:** Fires after every tool call. Increments counters, flags pending check-in if thresholds crossed.

**Acceptance:**
- Reads stdin JSON, extracts `session_id`, `tool_name`, `tool_input`.
- Calls `updateState`: increments `tool_calls_since_checkin` and `total_tool_calls` for this session. Records `last_tool_name` and a summary of `tool_input` (truncated to 200 chars).
- Checks thresholds from config. If either trips, sets `pending_checkin: true` on the session entry.
- Exits 0. No stdout.
- Short-circuit: if session entry has `disabled: true`, exit 0 immediately.
- Must complete in <50ms typical. Skip any work beyond counter updates.
- Tests: fixture with 41 sequential invocations (crosses default 40 threshold), assert `pending_checkin` set after 41st. Fixture with disabled session, assert no state change.

---

### T-010: Stop hook (Hooks)

**Depends on:** T-004, T-005, T-007, T-012 (prompt templates)
**Files:** `src/hooks/stop.ts`, `tests/hooks/stop.test.ts`, `tests/fixtures/stop-*.json`

**Description:** Fires when the agent stops responding. If a check-in is pending, generates a one-sentence break suggestion via `claude -p` and fires a notification. No second, prompt-type hook — a single `command`-type Stop hook does everything. This keeps `SessionEntry` free of a transient pending-prompt field and removes the marker-file handoff. (Resolved 2026-04-16 after Wave 1 review.)

Implementation sketch:
- The command-type Stop hook reads state, decides if a check-in is needed, and if so generates the final break suggestion by invoking `claude -p "<filled-prompt>"` in a subshell. It then calls `notify()` directly.

**Acceptance:**
- Reads stdin JSON, extracts `session_id`.
- If session is disabled or no `pending_checkin`, exits 0 silently.
- Otherwise: loads config for tone preset, loads appropriate prompt template from `src/prompts/`, fills it with session stats, invokes `claude -p "<filled-prompt>"` via child process with a 15s timeout, captures stdout, trims to a single line.
- Calls `notify({ title: "Idle", body: <suggestion> })`.
- Updates state: `tool_calls_since_checkin = 0`, `last_checkin_at = now()`, append to `checkins`, clear `pending_checkin`.
- Exits 0. No stdout.
- Graceful degradation: if `claude -p` fails or times out, fall back to the `silent` preset output (bare stats line).
- Tests: fixture with pending check-in, mock `child_process.exec` to return a suggestion, assert notify called with correct body, assert state reset. Fixture with no pending check-in, assert no-op.

---

### T-011: SessionEnd hook (Hooks)

**Depends on:** T-004, T-005
**Files:** `src/hooks/session-end.ts`, `tests/hooks/session-end.test.ts`

**Description:** Fires at session end. Writes summary to disk, removes session from live state.

**Acceptance:**
- Reads stdin JSON, extracts `session_id`.
- Reads the session entry from state, writes it to `~/.idle/sessions/<session_id>.json`.
- Removes the entry from live state.
- Exits 0. No stdout.
- Tests: fixture round-trip, verify summary file created and state entry removed.

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

**Acceptance:**
- `bin/idle` is a shebang script: `#!/usr/bin/env node` followed by `import('../dist/cli.js')` — or during dev, points to tsx.
- `idle --help` lists all subcommands with one-line descriptions matching the Idle voice.
- `idle --version` prints package version.
- Subcommands not yet implemented stub to a "not implemented" error.

---

### T-014: init, install, uninstall commands (CLI)

**Depends on:** T-004, T-006, T-013
**Files:** `src/commands/init.ts`, `src/commands/install.ts`, `src/commands/uninstall.ts`, tests

**Description:** Three commands that together handle the install lifecycle.

**Acceptance:**
- `idle init`: interactive. Uses `prompts` library. Asks for: tone preset (select from 4), time threshold (number, default 45), tool call threshold (number, default 40), notification method (select from 3). Confirms before writing. On confirm: calls `saveConfig()`, then `installHooks()`. Prints success + next-steps in Idle voice.
- `idle install [--defaults]`: same as init but non-interactive. Uses flags or defaults.
- `idle uninstall [--purge]`: calls `uninstallHooks()`. If `--purge`, also removes `~/.idle/`. Prints what was removed and path of backup file.
- All three refuse to run and print a helpful error if `~/.claude/` is missing.
- Tests: spawn each command in a sandboxed `IDLE_HOME`, assert files created/removed correctly.

---

### T-015: stats, status, enable, disable commands (CLI)

**Depends on:** T-004, T-005, T-013
**Files:** `src/commands/stats.ts`, `status.ts`, `enable.ts`, `disable.ts`, tests

**Description:** Read-only and config-toggle commands.

**Acceptance:**
- `idle stats [--today | --all | --session <id>]`: reads `~/.idle/sessions/*.json` and live state, prints aggregate stats. Default view: active session or most recent session.
- Output format for stats: terse table in the Idle voice. No emoji, no color except for "active" indicator.
- `idle status`: shows install status (hooks registered? config present? current-project enabled?). Green/red based on each check.
- `idle disable`: uses `pwd`, updates config to mark current project disabled. Prints confirmation.
- `idle enable`: inverse.
- Tests per command with fixture state and sandboxed IDLE_HOME.

---

### T-016: doctor command (CLI)

**Depends on:** T-004, T-006, T-013
**Files:** `src/commands/doctor.ts`, tests

**Description:** Diagnostic command that reports health.

**Acceptance:**
- Checks: Claude Code present (binary on PATH), `~/.claude/` exists, `~/.claude/settings.json` readable, Idle hooks registered in settings.json, Idle config valid, Idle state readable, notification tool present (osascript on mac / notify-send on linux), tsx resolvable (so hooks can actually run).
- Each check prints pass/fail with a one-line explanation.
- Exit code 0 if all pass, 1 if any fail.
- Fail messages include the specific next step (e.g. "Run `idle install` to register hooks").
- Tests: each individual check mockable.

---

### T-017: bin/idle + build config (CLI, small)

**Depends on:** T-013
**Files:** `bin/idle`, build scripts in `package.json`

**Description:** Ensure the CLI is runnable both in dev (via tsx) and after install (via built dist/).

**Acceptance:**
- `npm run build` produces `dist/cli.js` and keeps import paths working (ESM).
- `bin/idle` resolves correctly when installed globally via npm.
- `npx tsx src/cli.ts --help` works in dev.
- `npm link` + `idle --help` works as end-user sanity check.

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

### F-001: `npm pack --dry-run` tarball is unusable (Architect / T-017)

**Raised by:** gpt-review-5 on PR #4 (T-006).

**What's wrong:** `package.json` declares `"bin": { "idle": "./bin/idle" }` and whitelists `["bin", "src", "README.md", "LICENSE"]` in `files`, but the repo does not contain `bin/idle` and `dist/` isn't in the whitelist either. A `npm pack` tarball on any current branch ships only `.ts` source — no executable, no compiled runtime. Publishing as-is would fail at `npm install -g`.

**Why this isn't T-006's scope:** settings.ts and its runtime path resolution already ship correctly with src/-only (verified by T-006 round-5 H1 fix: `resolveHooksDirFromModule` always lands at `<pkg>/src/hooks/`, and `npx tsx` executes the `.ts` sources directly). The missing piece is the CLI entrypoint, which is T-013 / T-017.

**Needs:**
- `bin/idle` shebang script (T-013).
- `package.json` bin + files sanity pass once T-013 + T-017 land: either ship `dist/` and point `bin/idle` at `dist/cli.js`, or keep the tarball source-only and point `bin/idle` at `src/cli.ts` via `npx tsx`. PRD §8 suggests the latter for hooks; the same pattern is viable for the CLI entrypoint.
- Re-run `npm pack --dry-run` after T-017 to verify.

### F-002: share `writeAllSync` across state.internal.ts and settings.ts (Core)

**Raised by:** gpt-review-4 / D5 on PR #4 (T-006).

**What's wrong:** T-005's `state.internal.ts` has a local `writeAllSync` implementation; T-006 added the canonical one in `src/lib/fs.ts`. Two implementations means two places to drift.

**Needs:** when T-005's PR (#7) merges, drop state.internal.ts's local copy and import from `src/lib/fs.ts`. Small, mechanical change. See the CLAUDE.md "Shared safety primitives" section for the convention.
