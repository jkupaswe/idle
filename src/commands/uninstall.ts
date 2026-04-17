import type { Command } from 'commander';

import { notImplemented } from './_stub.js';

export function register(program: Command): void {
  program
    .command('uninstall')
    .description('Remove Idle hooks from Claude Code settings.')
    .action(() => notImplemented('uninstall'));
}
