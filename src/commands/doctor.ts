import type { Command } from 'commander';

import { notImplemented } from './_stub.js';

export function register(program: Command): void {
  program
    .command('doctor')
    .description('Run diagnostics on the Idle install.')
    .action(() => notImplemented('doctor'));
}
