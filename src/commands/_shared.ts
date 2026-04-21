import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Buffer } from 'node:buffer';
import { delimiter, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

import type { ConfigParseError, ConfigValidationError } from '../core/config.js';
import {
  IDLE_HOOK_EVENTS,
  defaultHooksDir,
  uninstallHooks,
  type InstallResult,
  type UninstallResult,
} from '../core/settings.js';
import {
  claudeSettingsPath,
  idleConfigPath,
  idleHome,
  idleSessionsDir,
} from '../lib/paths.js';

const CLAUDE_URL = 'https://claude.com/product/claude-code';

/**
 * Full install preflight. Runs every check that can fail without a
 * pre-existing mutation before `installHooks()` or any file write.
 * Throws with a terse user-facing message on the first failure;
 * callers catch, print the message to stderr, and exit 1.
 */
export function validateInstallPreconditions(): void {
  ensureClaudeHomeExists();
  ensureHookScriptsPresent();
  ensureClaudeOnPath();
  ensureIdleHomeWritable();
  ensureStateJsonIsValidOrMissing();
  ensureDebugLogIsValidOrMissing();
  ensureSessionsDirIsValidOrMissing();
}

/**
 * Directory-only guard used by `uninstall`. Removing entries from
 * settings.json does not require hook scripts or `claude` to be
 * present — otherwise a damaged node_modules could strand users
 * with Idle hooks in settings.json they can't remove.
 */
export function ensureClaudeHome(): boolean {
  const dir = dirname(claudeSettingsPath());
  if (existsSync(dir)) return true;
  process.stderr.write(
    `~/.claude/ not found. Install Claude Code first: ${CLAUDE_URL}\n`,
  );
  return false;
}

function ensureClaudeHomeExists(): void {
  const dir = dirname(claudeSettingsPath());
  if (existsSync(dir)) return;
  throw new Error(
    `~/.claude/ not found. Install Claude Code first: ${CLAUDE_URL}`,
  );
}

function ensureClaudeOnPath(): void {
  if (resolveClaudeOnPath() !== null) return;
  throw new Error(
    `claude not found on PATH. Install Claude Code first: ${CLAUDE_URL}`,
  );
}

function ensureHookScriptsPresent(): void {
  const dir = defaultHooksDir();
  for (const hook of IDLE_HOOK_EVENTS) {
    const abs = join(dir, hook.script);
    if (isRegularFile(abs)) continue;
    throw new Error(
      `idle is missing an internal hook script: ${abs}. Re-install the package.`,
    );
  }
}

/**
 * Ensure `~/.idle/` exists, is a directory, and is writable. Creates
 * the directory if missing; a writability probe (touch + unlink) fails
 * early on read-only filesystems or restrictive permissions before any
 * settings.json mutation.
 */
function ensureIdleHomeWritable(): void {
  const home = idleHome();
  try {
    if (!existsSync(home)) {
      mkdirSync(home, { recursive: true });
    }
    const stat = statSync(home);
    if (!stat.isDirectory()) {
      throw new Error(`idle: ~/.idle exists but is not a directory`);
    }
    const probe = join(home, `.idle-write-test-${randomBytes(4).toString('hex')}`);
    writeFileSync(probe, '');
    unlinkSync(probe);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('idle: ~/.idle exists')) {
      throw err;
    }
    throw new Error(
      `idle: ~/.idle is not writable: ${(err as Error).message}`,
    );
  }
}

function ensureStateJsonIsValidOrMissing(): void {
  const statePath = join(idleHome(), 'state.json');
  if (!existsSync(statePath)) return;
  if (!statSync(statePath).isFile()) {
    throw new Error(
      `idle: ~/.idle/state.json exists but is not a regular file`,
    );
  }
}

function ensureDebugLogIsValidOrMissing(): void {
  const logPath = join(idleHome(), 'debug.log');
  if (!existsSync(logPath)) return;
  if (!statSync(logPath).isFile()) {
    throw new Error(
      `idle: ~/.idle/debug.log exists but is not a regular file`,
    );
  }
}

function ensureSessionsDirIsValidOrMissing(): void {
  const sessionsPath = idleSessionsDir();
  if (!existsSync(sessionsPath)) return;
  if (!statSync(sessionsPath).isDirectory()) {
    throw new Error(
      `idle: ~/.idle/sessions exists but is not a directory`,
    );
  }
}

/**
 * Cross-platform `which claude`. Walks `process.env.PATH` and returns
 * the resolved absolute path of the first executable regular file
 * named `claude` (accounting for Windows `PATHEXT`). Returns `null`
 * when nothing matches. `accessSync` alone accepts directories with
 * the execute bit set (common for `~/bin/claude/`), so we require
 * `isFile()` too.
 */
export function resolveClaudeOnPath(): string | null {
  const rawPath = process.env.PATH ?? '';
  if (rawPath.length === 0) return null;
  const candidateNames = executableNames('claude');
  for (const dir of rawPath.split(delimiter)) {
    if (dir.length === 0) continue;
    for (const name of candidateNames) {
      const candidate = join(dir, name);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // keep walking
      }
    }
  }
  return null;
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function executableNames(base: string): string[] {
  if (process.platform !== 'win32') return [base];
  const pathext = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .filter((s) => s.length > 0);
  return [base, ...pathext.map((ext) => `${base}${ext.toLowerCase()}`)];
}

/**
 * `configNote` is an optional middle sentence between "Installed." and
 * the backup sentence — used by `idle install` to report whether it
 * wrote defaults, preserved an existing config, or reset one.
 */
export function formatInstallResult(
  result: InstallResult,
  configNote?: string,
): number {
  if (result.ok) {
    const parts = ['Installed.'];
    if (configNote !== undefined) parts.push(configNote);
    if (result.backupPath !== null) {
      parts.push(`Previous settings backed up to ${result.backupPath}.`);
    }
    process.stdout.write(`${parts.join(' ')}\n`);
    return 0;
  }
  if (result.reason === 'claude_not_installed') {
    process.stderr.write(
      `Claude Code not found. Install it first: ${CLAUDE_URL}\n`,
    );
    return 1;
  }
  writeSettingsFailure(result.reason, result.detail);
  return 1;
}

export function formatUninstallResult(result: UninstallResult): number {
  if (result.ok) {
    if (!result.fileExisted) {
      process.stdout.write(
        'No Claude Code settings file found; nothing to uninstall.\n',
      );
    } else if (result.removedEvents.length === 0) {
      process.stdout.write('No Idle hooks found in settings.json.\n');
    } else if (result.backupPath !== null) {
      process.stdout.write(
        `Uninstalled. Previous settings backed up to ${result.backupPath}.\n`,
      );
    } else {
      process.stdout.write('Uninstalled.\n');
    }
    return 0;
  }
  writeSettingsFailure(result.reason, result.detail);
  return 1;
}

function writeSettingsFailure(
  reason: 'permission_denied' | 'malformed_settings' | 'timeout',
  detail: string,
): void {
  switch (reason) {
    case 'permission_denied':
      process.stderr.write(
        `Cannot write to ~/.claude/settings.json: ${detail}.\n`,
      );
      return;
    case 'malformed_settings':
      process.stderr.write(
        `Could not read ~/.claude/settings.json: ${detail}.\n`,
      );
      return;
    case 'timeout':
      process.stderr.write(
        `Could not acquire lock on ~/.claude/settings.json: ${detail}.\n`,
      );
      return;
  }
}

export function writeConfigLoadError(
  err: ConfigParseError | ConfigValidationError,
): void {
  process.stderr.write(`${err.message}\n`);
  process.stderr.write(
    'Run `idle install --defaults` to overwrite, or edit the file.\n',
  );
}

/**
 * Read `~/.idle/config.toml` into a buffer. Returns `null` when the
 * file does not exist. Any other I/O failure propagates. Callers
 * take the snapshot before calling `saveConfig()` so they can restore
 * a user's customizations if a later install step fails.
 */
export function snapshotConfig(): Buffer | null {
  try {
    return readFileSync(idleConfigPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Undo a `saveConfig()` that ran as part of a failed install:
 * - If a snapshot was captured, restore it byte-for-byte.
 * - If no snapshot (config didn't exist pre-install), unlink the
 *   config we wrote.
 * Unlink is best-effort — ENOENT is fine; other errors propagate.
 */
export function restoreConfigSnapshot(snapshot: Buffer | null): void {
  const path = idleConfigPath();
  if (snapshot !== null) {
    writeFileSync(path, snapshot);
    return;
  }
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Undo a just-completed `installHooks()` after a post-hook step
 * (saveConfig, provisionIdleHome) fails. Restores settings.json from
 * the backup `installHooks()` produced — or unlinks the file when the
 * install created it fresh — so pre-existing non-Idle hooks survive a
 * failed reinstall.
 *
 * If the preferred path fails, falls back to `uninstallHooks()`. If
 * that fails too, the user gets a terse "Rollback failed. Run
 * `idle uninstall`" line and exit 1.
 */
export async function rollbackInstalledHooks(opts: {
  settingsPath: string;
  backupPath: string | null;
}): Promise<void> {
  if (opts.backupPath !== null) {
    try {
      writeFileSync(opts.settingsPath, readFileSync(opts.backupPath));
      return;
    } catch {
      // fall through to best-effort uninstall
    }
  } else {
    try {
      unlinkSync(opts.settingsPath);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      // fall through
    }
  }

  const result = await uninstallHooks({ settingsPath: opts.settingsPath });
  if (!result.ok) {
    process.stderr.write(
      `Rollback failed: ${result.detail}. Run \`idle uninstall\` to clean up.\n`,
    );
  }
}

export function writePostHookFailure(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`install failed after hooks were registered: ${msg}\n`);
}

/**
 * Provision the PRD §6.1 runtime layout under `~/.idle/`:
 * - `~/.idle/` directory.
 * - `~/.idle/sessions/` directory.
 * - `~/.idle/state.json` if missing (empty-state shape, not `{}`, so
 *   `readState()` doesn't treat it as a schema mismatch and back it up).
 * - `~/.idle/debug.log` touched via append-mode so existing content
 *   survives a re-install.
 *
 * Runs after `installHooks()` and `saveConfig()` have succeeded.
 * File-type invariants (regular file vs. directory) are enforced by
 * `validateInstallPreconditions()` before hooks land, so this function
 * only writes.
 */
export function provisionIdleHome(): void {
  const home = idleHome();
  mkdirSync(home, { recursive: true });
  mkdirSync(idleSessionsDir(), { recursive: true });

  try {
    writeFileSync(
      join(home, 'state.json'),
      `${JSON.stringify({ sessions: {} }, null, 2)}\n`,
      { flag: 'wx' },
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  writeFileSync(join(home, 'debug.log'), '', { flag: 'a' });
}
