import { existsSync, rmSync } from 'node:fs';

import type { Command } from 'commander';

import { uninstallHooks } from '../core/settings.js';
import { idleHome } from '../lib/paths.js';

import { ensureClaudeHomeExists, formatUninstallResult } from './_shared.js';

interface UninstallCliOptions {
  purge?: boolean;
}

export function register(program: Command): void {
  program
    .command('uninstall')
    .description('Remove Idle hooks from Claude Code settings.')
    .option('--purge', 'also remove ~/.idle/ (config and session history)')
    .action(async (options: UninstallCliOptions) => {
      const code = await runUninstall(options);
      process.exit(code);
    });
}

export async function runUninstall(
  options: UninstallCliOptions,
): Promise<number> {
  if (!ensureClaudeHomeExists()) return 1;

  const result = await uninstallHooks();
  const code = formatUninstallResult(result);
  if (code !== 0) return code;

  if (options.purge === true) {
    await maybePurgeIdleHome();
  }
  return 0;
}

async function maybePurgeIdleHome(): Promise<void> {
  const dir = idleHome();
  // Silent when there's nothing to purge: the preceding "Uninstalled"
  // message is already the command's visible result.
  if (!existsSync(dir)) return;

  const { default: prompts } = await import('prompts');
  const answer = (await prompts({
    type: 'confirm',
    name: 'confirm',
    message:
      'Purge will remove ~/.idle/ including config and session history. Continue?',
    initial: false,
  })) as { confirm?: boolean };
  if (answer.confirm !== true) {
    process.stdout.write('Purge cancelled.\n');
    return;
  }
  rmSync(dir, { recursive: true, force: true });
  process.stdout.write('Purged ~/.idle/.\n');
}
