import type { Command } from 'commander';

import { notImplemented } from './_stub.js';

export function register(program: Command): void {
  program
    .command('stats')
    .description('Show session stats.')
    .action(() => notImplemented('stats'));
}
