import type { Command } from 'commander';

import { notImplemented } from './_stub.js';

export function register(program: Command): void {
  program
    .command('install')
    .description('Install hooks without prompting.')
    .action(() => notImplemented('install'));
}
