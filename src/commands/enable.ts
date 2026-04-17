import type { Command } from 'commander';

import { notImplemented } from './_stub.js';

export function register(program: Command): void {
  program
    .command('enable')
    .description('Enable Idle for the current project.')
    .action(() => notImplemented('enable'));
}
