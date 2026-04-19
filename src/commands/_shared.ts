import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ConfigParseError, ConfigValidationError } from '../core/config.js';
import type { InstallResult, UninstallResult } from '../core/settings.js';
import { claudeSettingsPath } from '../lib/paths.js';

const CLAUDE_URL = 'https://claude.com/product/claude-code';

/**
 * Safety guard for init / install / uninstall. Uses
 * `dirname(claudeSettingsPath())` so the check honors
 * `IDLE_CLAUDE_SETTINGS_PATH` in tests (`claudeHome()` does not).
 */
export function ensureClaudeHomeExists(): boolean {
  const dir = dirname(claudeSettingsPath());
  if (existsSync(dir)) return true;
  process.stderr.write(
    `~/.claude/ not found. Install Claude Code first: ${CLAUDE_URL}\n`,
  );
  return false;
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

/**
 * Shared formatter for the three Core failure reasons that install and
 * uninstall have in common: `permission_denied`, `malformed_settings`,
 * `timeout`. Each maps to a terse stderr line.
 */
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

/**
 * Map a `ConfigParseError` or `ConfigValidationError` to the install
 * command's stderr lines. The second line tells the user how to recover,
 * which is why it lives here and not inside the error class.
 */
export function writeConfigLoadError(
  err: ConfigParseError | ConfigValidationError,
): void {
  process.stderr.write(`${err.message}\n`);
  process.stderr.write(
    'Run `idle install --defaults` to overwrite, or edit the file.\n',
  );
}
