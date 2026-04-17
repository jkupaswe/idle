# CLAUDE.md — Idle project guardrails

This file tells any Claude Code agent working on this repository how to behave. Read it in full before touching code.

## What this project is

Idle is a CLI tool that integrates with Claude Code via hooks to surface gentle break suggestions during long agentic coding sessions. See `PRD.md` for full scope.

## Stack and conventions

- **Language:** TypeScript, strict mode on. No `any` without a `// @ts-expect-error` and a comment explaining why.
- **Runtime:** Node 20+.
- **Module system:** ESM. `"type": "module"` in package.json. No CommonJS.
- **Imports:** Use `.js` extensions in import paths (ESM requirement), even when importing .ts files. `import { foo } from './foo.js'`.
- **Style:** Functional. Small files (<200 lines preferred). No classes unless a stateful object is genuinely warranted. No clever abstractions — this is a small CLI, not a framework.
- **Error handling:** Throw `Error` or subclasses. Never throw strings. All top-level catches in CLI commands print a user-friendly message to stderr and exit 1.
- **Logging:** All debug logging goes to `~/.idle/debug.log` via `src/lib/log.ts`. Never `console.log` inside hook scripts — Claude Code captures stdout for protocol use.

## Established architecture (load-bearing decisions)

These decisions are settled. Do not silently re-decide them during implementation. If you want to discuss any of them, file an issue or PR comment — but do not change them in-place.

### Shipping model

Idle ships TypeScript sources and executes hooks via `npx tsx`. No compiled `dist/` is produced or referenced at runtime. Installed hook commands have the form:

```
npx tsx /abs/path/src/hooks/<name>.ts # idle:v1
```

This decision is load-bearing across `src/core/settings.ts`, `package.json`'s `files` allowlist, and all CLI install/uninstall flows. Do not:
- Introduce a build step that emits `dist/`
- Reference `dist/` from runtime code paths
- Change hook paths to `.js` extensions
- Add bundlers, compilers, or transpilers to the runtime path

`tsc --noEmit` is used for typechecking only. No emit.

### Never-throw primitives

The following functions are contractually never-throw. They always resolve (if Promise) or return normally (if sync). Failures are logged to `~/.idle/debug.log` and swallowed.

- `log()` (src/lib/log.ts)
- `notify()` (src/core/notify.ts)

Callers do not need `try/catch` or `.catch()` around these. If you find yourself wrapping a call to one of them defensively, that is a signal that either the primitive has a bug (file one) or you are misreading the contract.

### Hook ownership

Idle-owned hooks in `~/.claude/settings.json` are identified by a strict three-condition predicate (`isIdleOwnedCommand` in `src/core/settings.ts`):

1. Command ends with `# idle:v1` (optionally trailing whitespace only)
2. Command starts with the canonical Idle prefix (`npx tsx `)
3. Embedded script path matches one of the four expected Idle hook paths

All three must be true. Substring matching is never used. This predicate is the only correct way to identify Idle-owned hooks.

### Async hook flag per event

When installing hooks into `~/.claude/settings.json`, the `async` flag is per-event:

- `SessionStart`: `async: true`
- `PostToolUse`: `async: true` (required for the <50ms latency guarantee in PRD §7)
- `Stop`: `async: false` (must complete before the notification fires)
- `SessionEnd`: `async: true`

This is encoded in the `IdleHookEvent` discriminated union in `src/core/settings.ts`. Do not emit sync hooks on async events or vice versa.

## Shared primitives (use these, do not reimplement)

Core Wave 2 produced a set of primitives that every Wave 2 and later agent must use rather than rolling their own. If a primitive should exist but doesn't, file a follow-up ticket to add it rather than inlining a one-off.

### Filesystem safety
- **`writeAllSync(fd, buffer)`** (src/lib/fs.ts) — loops until full buffer is written. Handles short-write edge cases on some filesystems. Use for any `fs.writeSync` call on files users care about. Do not call raw `fs.writeSync` or `fs.writeFileSync` directly on state/config/settings files.
- **`atomicWriteFile(path, data)`** (src/lib/fs.ts) — writes to temp file, fsyncs, renames. The canonical atomic-write primitive.

### Time
- **`nowIso()` / `timestampSuffix()`** (src/lib/time.ts) — filename-safe ISO suffixes for backup and corruption files. Never format timestamps inline.

### Branded types
- **`isAbsolutePath(x)` / `asAbsolutePath(x)`** (src/lib/types.ts + src/core/config.ts) — branded AbsolutePath validation. The guard returns a type predicate; the `as*` variant throws on invalid input.
- **`isSessionId(x)`** (src/lib/types.ts) — SessionId brand guard. Validates Claude Code session ID shape.
- **`ms(n)`** (src/lib/types.ts) — Milliseconds constructor. Validates non-negative finite; throws on invalid. Prevents seconds-vs-ms confusion.

### State (src/core/state.ts — public API)

Use the named helpers. `_updateState` is module-private by design and 
is not exported.

All mutating helpers accept an optional `options?: UpdateStateOptions` 
for overriding lock timeout and state file path. Hot-path callers have 
sensible defaults (incrementToolCounter uses 200ms fail-open); others 
default to DEFAULT_LOCK_TIMEOUT. Read-only helpers accept a narrower 
`Pick<UpdateStateOptions, 'path'>` — they don't need timeout or lock 
semantics.

All helpers return discriminated-result types; callers must handle 
every variant explicitly.

- **`readState(path?)`** → `ReadStateResult` 
  (`fresh | empty | recovered | partial`). Synchronous.
- **`registerSession(id, entry, options?)`** → `RegisterSessionResult`. 
  Atomic session init. Caller constructs the full `SessionEntry` 
  (see `src/lib/types.ts`). Async.
- **`removeSession(id, options?)`** → `RemoveSessionResult`. Atomic 
  session deletion. Async.
- **`takeSessionSnapshot(id, options?)`** → `SnapshotResult`. 
  Atomic read of entry. **Synchronous — do not await.** Options is 
  `Pick<UpdateStateOptions, 'path'>` (no timeout needed for reads).
- **`consumePendingCheckin(id, options?)`** → `ConsumePendingResult`. 
  Atomic read-and-clear of `pending_checkin`. Use for the Stop hook's 
  check-in logic. Race-safe; do not implement check-in clearing 
  manually. Async.
- **`incrementToolCounter(id, tool, thresholds, options?)`** → 
  `IncrementToolResult`. Atomic increment + threshold check. Defaults 
  to `ms(200)` timeout, fail-open (never throws on timeout). Use this 
  for `PostToolUse`; do not reach for `readState` + custom mutation. 
  Async.

**Subagent tool calls are out of scope for v1.** SessionEntry has 
optional `subagent_tool_calls_since_checkin` and 
`total_subagent_tool_calls` fields, and the threshold check sums main 
+ subagent counters when present. However, no code path currently 
writes the subagent counters; they remain undefined and contribute 
zero to the threshold. Tracked as F-003 for v2 — see Follow-ups in 
TASKS.md. Do NOT pass `isSubagent` or equivalent to 
`incrementToolCounter`; the `ToolCall` type does not accept it.

### Settings (src/core/settings.ts — public API)
- **`installHooks()`** — returns `InstallResult` discriminated union. Handles backup, atomic write, and file locking.
- **`uninstallHooks()`** — returns `UninstallResult` discriminated union. `fileExisted: false` when settings.json didn't exist; do not manufacture it.

### Config (src/core/config.ts — public API)
- **`loadConfig()`** — strict. Throws `ConfigParseError` on malformed TOML, `ConfigValidationError` on schema violation. Missing file returns defaults (logged to debug).
- **`saveConfig(config)`** — atomically writes TOML. Creates `~/.idle/` if missing.
- **`validateConfig(input)`** — returns discriminated `{ ok: true; config } | { ok: false; errors }`.
- **`ConfigParseError` / `ConfigValidationError`** — error classes with structured fields.

### Notification (src/core/notify.ts — public API)
- **`notify({ title, body, sound? })`** — never-throw per above. Shell-escapes inputs; uses `--` separator on Linux to prevent flag injection from LLM-generated content.

## File scope rules

Agents working on this repo must respect file ownership per the task graph in `TASKS.md`. If a ticket is assigned the `core/config.ts` scope, the agent does not edit `hooks/stop.ts` even if they spot a bug — they flag it in a PR comment or a follow-up ticket.

**Hard boundaries (never edit without explicit approval):**
- `package.json` dependencies — only the Architect agent adds deps; implementers request them in PR
- `tsconfig.json` — owned by Architect
- `.github/workflows/*` — owned by Architect
- Another agent's assigned files — coordinate via PR comments

## Implementation discipline

These rules apply to every ticket, every agent. They prevent the "drift" class of bugs that cost multiple review rounds during Core Wave 2.

1. **Explicitly restate settled decisions in your PR description.** If your ticket touches shipping model, hook ownership, async flags, or any primitive listed above, name the decision in the PR so reviewers can verify you honored it.

2. **Call out what NOT to do when relevant.** If your ticket has a plausible wrong path (e.g., "use `execFile`, not `spawn` or `exec`"), include the negative constraint. Negative constraints prevent drift more reliably than positive ones.

3. **Name specific primitives, not categories.** "Use `incrementToolCounter`" is stronger than "use the state module." Be precise in both tickets and PRs.

4. **If an implicit architectural decision could affect your work, treat that as a spec gap and flag it in a PR comment before implementing.** Do not resolve it silently. Do not pick "the cleaner option." Surface the ambiguity.

5. **For complex tickets, require a plan before code.** If your ticket has multiple non-trivial implicit decisions, produce a one-page design doc first (proposed types, failure modes, test matrix, library choices). Post it as a PR draft or issue comment. Wait for review before writing code.

## Safety rules (this is dev-tool code that writes to user homedirs)

This code writes to `~/.claude/settings.json` — the user's live Claude Code config. Mistakes here break other developers' setups. Therefore:

1. **Every file write under `~/.claude/` is atomic.** Use `atomicWriteFile` from `src/lib/fs.ts`. Never write in place.
2. **Every destructive operation creates a timestamped backup first.** No exceptions. Use `timestampSuffix()` for the filename.
3. **The uninstall path must be provably reversible.** Tests must verify that `install → uninstall` returns settings.json byte-identical to the pre-install state.
4. **Hook scripts must be defensive about malformed input.** Claude Code's hook JSON schema has evolved; never assume a field exists without checking.
5. **Concurrent writers on settings.json are handled by file locking** (`proper-lockfile`). Do not bypass.

## Testing requirements

- Every hook script has an integration test in `tests/hooks/` that feeds synthetic JSON via stdin and asserts on exit code, stderr, and any file side effects.
- Every `core/` module has unit tests.
- CLI commands have smoke tests (spawn a child process, assert on output/exit).
- Fixture files live in `tests/fixtures/` — real hook JSON payloads captured from running Claude Code, anonymized.
- Coverage is not a goal; behavior coverage of the critical paths (install, uninstall, hook-fires-notification, state-atomic-write) is.
- Tests must prove invariants, not just exercise code. "10 concurrent calls succeed" is weaker than "10 concurrent calls produce exactly one winner per race primitive." Prefer assertive concurrency tests over loose parallelism tests.

## Voice and copy

All user-facing strings (CLI output, error messages, README, help text, break suggestions in default prompt templates) follow the Idle voice:

- Dry, matter-of-fact, occasionally observational
- Unix-tool aesthetic. Terse. `htop`, `fd`, `ripgrep` are the reference points.
- Never preachy, never cheerful, never uses wellness-app language
- No emoji in default output
- Short. Every sentence earns its place.

**Bad:** "Great job! 🎉 You've been coding hard. Time for a well-deserved break! 💚"
**Good:** "47m, 32 tool calls. Look at something more than ten feet away."

Review any user-facing copy against these rules before committing.

## Commit hygiene

- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`.
- Subject line under 72 chars.
- Body (when needed) explains *why*, not *what*.
- Every PR references the ticket ID from `TASKS.md`, e.g. `feat(core): implement atomic state writer (TICKET-004)`.
- Adversarial-review fix commits reference the decision tag, e.g. `fix(core): enforce wall-clock deadline across state ops (gpt-review-3, Decision G)`.

## When in doubt

If a ticket's acceptance criteria are ambiguous, flag it in a PR comment rather than guessing. If two tickets seem to conflict, flag it. If you think the PRD is wrong, say so in the PR — but don't silently work around it.

## Model ownership (informational)

Different agents are running on different models. The Architect is on Opus, implementers are typically on Sonnet, docs agent is on Haiku, complex implementation tickets may use an Opus-design-then-Sonnet-implement split. Don't assume any single agent has read every ticket. Read the ticket you're assigned, read this file, read the PRD. That's your context.
