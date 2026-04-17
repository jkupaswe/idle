/**
 * Canonical filesystem paths for Idle.
 *
 * All paths are derived from `os.homedir()` so the module runs on any
 * machine without hardcoded user paths. For test isolation, setting the
 * `IDLE_HOME` environment variable redirects every `~/.idle/*` path; the
 * Claude Code paths use `IDLE_CLAUDE_SETTINGS_PATH` (see `core/settings.ts`)
 * or fall back to `~/.claude/`.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Root directory for Idle's own state and config.
 *
 * Returns `$IDLE_HOME` verbatim when set (for tests), otherwise
 * `~/.idle`. The value is re-read from the environment on each call so
 * tests that mutate `process.env` between assertions see the change.
 */
export function idleHome(): string {
  const override = process.env.IDLE_HOME;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), '.idle');
}

/** Path to `~/.idle/config.toml` (or its IDLE_HOME-rebased equivalent). */
export function idleConfigPath(): string {
  return join(idleHome(), 'config.toml');
}

/** Path to `~/.idle/state.json`. */
export function idleStatePath(): string {
  return join(idleHome(), 'state.json');
}

/** Directory where per-session summary files are written on SessionEnd. */
export function idleSessionsDir(): string {
  return join(idleHome(), 'sessions');
}

/** Path to the debug log file written by `src/lib/log.ts`. */
export function idleDebugLog(): string {
  return join(idleHome(), 'debug.log');
}

/** Root of the user's Claude Code install directory. Always `~/.claude`. */
export function claudeHome(): string {
  return join(homedir(), '.claude');
}

/**
 * Path to Claude Code's `settings.json` file.
 *
 * Honors `IDLE_CLAUDE_SETTINGS_PATH` as a full-file override so tests
 * can point install/uninstall at a sandbox file.
 */
export function claudeSettingsPath(): string {
  const override = process.env.IDLE_CLAUDE_SETTINGS_PATH;
  if (override && override.length > 0) {
    return override;
  }
  return join(claudeHome(), 'settings.json');
}
