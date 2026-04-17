import type { Command } from 'commander';

import { notImplemented } from './_stub.js';

export function register(program: Command): void {
  program
    .command('init')
    .description('Interactive setup. Writes config and installs hooks.')
    .action(() => notImplemented('init'));
}
