import { accessSync, constants as fsConstants, existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

import type { ConfigParseError, ConfigValidationError } from '../core/config.js';
import {
  IDLE_HOOK_EVENTS,
  defaultHooksDir,
  type InstallResult,
  type UninstallResult,
} from '../core/settings.js';
import { claudeSettingsPath } from '../lib/paths.js';

const CLAUDE_URL = 'https://claude.com/product/claude-code';

/**
 * Full preflight for init / install / uninstall. Per PRD §6.1:
 * - `~/.claude/` must exist.
 * - `claude` must be on PATH.
 * - Idle's own hook scripts must be present (otherwise a "successful"
 *   install writes dead hook commands that fire and fail).
 *
 * Returns true when all three pass. Otherwise prints a terse stderr
 * line identifying the specific gap and returns false.
 */
export function ensureClaudeInstalled(): boolean {
  if (!ensureClaudeHomeExists()) return false;
  if (!ensureClaudeOnPath()) return false;
  if (!ensureHookScriptsPresent()) return false;
  return true;
}

/**
 * Narrower guard used by `uninstall` when the PATH binary isn't
 * required (removing hooks doesn't need to actually run `claude`).
 */
export function ensureClaudeHomeAndHookScripts(): boolean {
  if (!ensureClaudeHomeExists()) return false;
  if (!ensureHookScriptsPresent()) return false;
  return true;
}

function ensureClaudeHomeExists(): boolean {
  const dir = dirname(claudeSettingsPath());
  if (existsSync(dir)) return true;
  process.stderr.write(
    `~/.claude/ not found. Install Claude Code first: ${CLAUDE_URL}\n`,
  );
  return false;
}

function ensureClaudeOnPath(): boolean {
  if (claudeOnPath()) return true;
  process.stderr.write(
    `claude not found on PATH. Install Claude Code first: ${CLAUDE_URL}\n`,
  );
  return false;
}

function ensureHookScriptsPresent(): boolean {
  const dir = defaultHooksDir();
  for (const hook of IDLE_HOOK_EVENTS) {
    const abs = join(dir, hook.script);
    if (existsSync(abs)) continue;
    process.stderr.write(
      `idle is missing an internal hook script: ${abs}. Re-install the package.\n`,
    );
    return false;
  }
  return true;
}

/**
 * Cross-platform `which claude`. Walks `process.env.PATH` and checks
 * each entry for an executable. Returns true on the first hit. Honors
 * `PATHEXT` on Windows so `claude.cmd` / `claude.exe` resolve.
 */
function claudeOnPath(): boolean {
  const rawPath = process.env.PATH ?? '';
  if (rawPath.length === 0) return false;
  const candidateNames = executableNames('claude');
  for (const dir of rawPath.split(delimiter)) {
    if (dir.length === 0) continue;
    for (const name of candidateNames) {
      try {
        accessSync(join(dir, name), fsConstants.X_OK);
        return true;
      } catch {
        // keep walking
      }
    }
  }
  return false;
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
