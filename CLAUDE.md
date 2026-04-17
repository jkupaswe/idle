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

## File scope rules

Agents working on this repo must respect file ownership per the task graph in `TASKS.md`. If a ticket is assigned the `core/config.ts` scope, the agent does not edit `hooks/stop.ts` even if they spot a bug — they flag it in a PR comment or a follow-up ticket.

**Hard boundaries (never edit without explicit approval):**
- `package.json` dependencies — only the Architect agent adds deps; implementers request them in PR
- `tsconfig.json` — owned by Architect
- `.github/workflows/*` — owned by Architect
- Another agent's assigned files — coordinate via PR comments

## Safety rules (this is dev-tool code that writes to user homedirs)

This code writes to `~/.claude/settings.json` — the user's live Claude Code config. Mistakes here break other developers' setups. Therefore:

1. **Every file write under `~/.claude/` is atomic.** Write to temp file, fsync, rename. Never write in place.
2. **Every destructive operation creates a timestamped backup first.** No exceptions.
3. **The uninstall path must be provably reversible.** Tests must verify that `install → uninstall` returns settings.json byte-identical to the pre-install state (modulo the backup file).
4. **Never use `fs.writeFileSync` on settings.json directly.** Use `atomicWriteFile` from `src/lib/fs.ts`, or the named helpers in `src/core/settings.ts`.
5. **Hook scripts must be defensive about malformed input.** Claude Code's hook JSON schema has evolved; never assume a field exists without checking.

## Shared safety primitives (use these, don't reimplement)

Reach for these helpers before writing a local version. If a primitive should exist but doesn't, file a follow-up ticket or leave a PR comment — don't inline a new one.

- `writeAllSync(fd, buffer)` — `src/lib/fs.ts`. Atomic full-buffer write that handles short-write edge cases on NFS / FUSE / container overlays. Use for any `fs.writeSync` on a file users care about.
- `atomicWriteFile(path, contents)` — `src/lib/fs.ts`. Temp + `fsync` + `rename`; layers on `writeAllSync`. The default write path for state.json and settings.json.
- `timestampSuffix()` / `nowIso()` — `src/lib/time.ts`. Filename-safe ISO suffixes for backup files; ISO-8601 strings for logs and on-disk timestamps.
- `isAbsolutePath` / `asAbsolutePath` — `src/core/config.ts` (brand re-exported from `src/lib/types.ts`). Validation + brand crossing for POSIX absolute paths.
- `isSessionId` — `src/lib/types.ts`. Branded `SessionId` guard for Claude Code session identifiers.
- `isValidSessionEntry` — `src/lib/types.ts`. Per-entry schema guard for `SessionState.sessions`; malformed entries are backed up to a sidecar rather than crashing helpers.
- `ms(n)` — `src/lib/types.ts`. `Milliseconds` constructor with non-negative-finite validation. Prevents seconds-vs-ms bugs at call sites.
- `log(level, msg, meta?)` — `src/lib/log.ts`. Debug logger; never throws. Never `console.*` inside hook scripts.

## Testing requirements

- Every hook script has an integration test in `tests/hooks/` that feeds synthetic JSON via stdin and asserts on exit code, stderr, and any file side effects.
- Every `core/` module has unit tests.
- CLI commands have smoke tests (spawn a child process, assert on output/exit).
- Fixture files live in `tests/fixtures/` — real hook JSON payloads captured from running Claude Code, anonymized.
- Coverage is not a goal; behavior coverage of the critical paths (install, uninstall, hook-fires-notification, state-atomic-write) is.

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

## When in doubt

If a ticket's acceptance criteria are ambiguous, flag it in a PR comment rather than guessing. If two tickets seem to conflict, flag it. If you think the PRD is wrong, say so in the PR — but don't silently work around it.

## Model ownership (informational)

Different agents are running on different models. The Architect is on Opus, implementers are on Sonnet, docs agent is on Haiku. Don't assume any single agent has read every ticket. Read the ticket you're assigned, read this file, read the PRD. That's your context.
