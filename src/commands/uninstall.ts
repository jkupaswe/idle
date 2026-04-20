import { existsSync, rmSync } from 'node:fs';

import type { Command } from 'commander';

import { uninstallHooks } from '../core/settings.js';
import { idleHome } from '../lib/paths.js';

import { ensureClaudeHome, formatUninstallResult } from './_shared.js';

interface UninstallCliOptions {
  purge?: boolean;
  yes?: boolean;
}

type PurgePlan = 'none' | 'confirmed' | 'declined';

export function register(program: Command): void {
  program
    .command('uninstall')
    .description('Remove Idle hooks from Claude Code settings.')
    .option('--purge', 'also remove ~/.idle/ (config and session history)')
    .option('-y, --yes', 'skip the --purge confirmation prompt')
    .action(async (options: UninstallCliOptions) => {
      const code = await runUninstall(options);
      process.exit(code);
    });
}

export async function runUninstall(
  options: UninstallCliOptions,
): Promise<number> {
  if (!ensureClaudeHome()) return 1;

  // Resolve the purge decision upfront so a non-TTY --purge without
  // --yes fails before touching ~/.claude/settings.json. Otherwise the
  // prompt crashes and the machine is left half-uninstalled.
  const purge = await resolvePurge(options);
  if (purge === 'error') return 1;

  const result = await uninstallHooks();
  const code = formatUninstallResult(result);
  if (code !== 0) return code;

  if (purge === 'confirmed') {
    rmSync(idleHome(), { recursive: true, force: true });
    process.stdout.write('Purged ~/.idle/.\n');
  } else if (purge === 'declined') {
    process.stdout.write('Purge cancelled.\n');
  }
  return 0;
}

async function resolvePurge(
  options: UninstallCliOptions,
): Promise<PurgePlan | 'error'> {
  if (options.purge !== true) return 'none';
  if (!existsSync(idleHome())) return 'none';
  if (options.yes === true) return 'confirmed';

  if (!process.stdin.isTTY) {
    process.stderr.write(
      '--purge requires confirmation. Re-run with --yes to purge non-interactively.\n',
    );
    return 'error';
  }

  const { default: prompts } = await import('prompts');
  const answer = (await prompts({
    type: 'confirm',
    name: 'confirm',
    message:
      'Purge will remove ~/.idle/ including config and session history. Continue?',
    initial: false,
  })) as { confirm?: boolean };
  return answer.confirm === true ? 'confirmed' : 'declined';
}
