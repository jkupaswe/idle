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
import type { IdleConfig } from '../lib/types.js';

import {
  ensureClaudeInstalled,
  formatInstallResult,
  provisionIdleHome,
  rollbackInstalledHooks,
  writeConfigLoadError,
  writePostHookFailure,
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

interface PlannedConfig {
  /** The config to write when install succeeds. Null means keep on-disk config. */
  write: IdleConfig | null;
  /** Optional middle sentence in the success output. */
  note?: string;
}

export async function runInstall(options: InstallCliOptions): Promise<number> {
  if (!ensureClaudeInstalled()) return 1;

  const plan = resolveConfigPlan(options);
  if (plan === 'config_error') return 1;

  // Hooks first, config second — a failed install must not leave a
  // stray or reset config.toml on disk.
  const result = await installHooks();
  if (!result.ok) return formatInstallResult(result);

  try {
    if (plan.write !== null) saveConfig(plan.write);
    provisionIdleHome();
  } catch (err) {
    writePostHookFailure(err);
    await rollbackInstalledHooks();
    return 1;
  }

  return formatInstallResult(result, plan.note);
}

function resolveConfigPlan(
  options: InstallCliOptions,
): PlannedConfig | 'config_error' {
  const hadConfig = existsSync(idleConfigPath());

  if (options.defaults === true) {
    return {
      write: defaultConfig(),
      note: hadConfig ? 'Config reset to defaults.' : undefined,
    };
  }
  if (!hadConfig) {
    return { write: defaultConfig() };
  }

  // Existing config path: validate before preserving — a malformed
  // config is a user-visible error, not a silent overwrite.
  try {
    loadConfig();
  } catch (err) {
    if (err instanceof ConfigValidationError || err instanceof ConfigParseError) {
      writeConfigLoadError(err);
      return 'config_error';
    }
    throw err;
  }
  return { write: null, note: 'Existing config preserved.' };
}
