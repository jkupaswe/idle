/**
 * Idle CLI dispatcher.
 *
 * Wires up commander, registers every subcommand, and parses argv. Each
 * subcommand lives in its own file under `src/commands/` and exposes a
 * `register(program)` function that attaches itself to the top-level
 * `Command`. No command logic is inlined here.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { register as registerDisable } from './commands/disable.js';
import { register as registerDoctor } from './commands/doctor.js';
import { register as registerEnable } from './commands/enable.js';
import { register as registerInit } from './commands/init.js';
import { register as registerInstall } from './commands/install.js';
import { register as registerStats } from './commands/stats.js';
import { register as registerStatus } from './commands/status.js';
import { register as registerUninstall } from './commands/uninstall.js';

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, '..', 'package.json');
  const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
  if (typeof parsed.version !== 'string') {
    throw new Error(`package.json at ${pkgPath} has no string "version" field`);
  }
  return parsed.version;
}

function buildProgram(): Command {
  const program = new Command();

  program
    .name('idle')
    .description('A break timer that meters your tokens, not your minutes.')
    .version(readPackageVersion(), '-v, --version', 'print version')
    .showHelpAfterError();

  registerInit(program);
  registerInstall(program);
  registerUninstall(program);
  registerStats(program);
  registerStatus(program);
  registerEnable(program);
  registerDisable(program);
  registerDoctor(program);

  return program;
}

async function main(argv: readonly string[]): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv as string[]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`idle: ${msg}\n`);
    process.exit(1);
  }
}

await main(process.argv);
