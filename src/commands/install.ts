import { existsSync } from 'node:fs';

import type { Command } from 'commander';

import {
  ConfigParseError,
  ConfigValidationError,
  defaultConfig,
  loadConfig,
  saveConfig,
} from '../core/config.js';
import { installHooks } from '../core/settings.js';
import { idleConfigPath } from '../lib/paths.js';

import {
  ensureClaudeHomeExists,
  formatInstallResult,
  writeConfigLoadError,
} from './_shared.js';

interface InstallCliOptions {
  defaults?: boolean;
}

export function register(program: Command): void {
  program
    .command('install')
    .description('Install hooks without prompting.')
    .option('--defaults', 'write default config values')
    .action(async (options: InstallCliOptions) => {
      const code = await runInstall(options);
      process.exit(code);
    });
}

export async function runInstall(options: InstallCliOptions): Promise<number> {
  if (!ensureClaudeHomeExists()) return 1;

  const hadConfig = existsSync(idleConfigPath());
  let configNote: string | undefined;

  if (options.defaults === true) {
    saveConfig(defaultConfig());
    if (hadConfig) configNote = 'Config reset to defaults.';
  } else if (!hadConfig) {
    saveConfig(defaultConfig());
  } else {
    // Validate the existing config before preserving it — a malformed
    // config is a user-visible error, not a silent overwrite.
    try {
      loadConfig();
    } catch (err) {
      if (err instanceof ConfigValidationError || err instanceof ConfigParseError) {
        writeConfigLoadError(err);
        return 1;
      }
      throw err;
    }
    configNote = 'Existing config preserved.';
  }

  const result = await installHooks();
  return formatInstallResult(result, configNote);
}
