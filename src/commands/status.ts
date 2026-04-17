import type { Command } from 'commander';

import { notImplemented } from './_stub.js';

export function register(program: Command): void {
  program
    .command('status')
    .description('Show install and enablement state for this directory.')
    .action(() => notImplemented('status'));
}
