/**
 * Idle CLI dispatcher.
 *
 * Wires up commander, registers every subcommand, and parses argv. Each
 * subcommand lives in its own file under `src/commands/` and exposes a
 * `register(program)` function that attaches itself to the top-level
 * `Command`. No command logic is inlined here.
 *
 * All bootstrap (version read, program build, argv parse) runs inside
 * `main()`'s try/catch so broken installs and command-action throws produce
 * a terse Idle-voice stderr line plus a debug-log entry — never a raw Node
 * stack trace.
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
import { log } from './lib/log.js';

/**
 * Startup failure with a pre-formatted user-facing line. `main()` prints
 * `userLine` verbatim to stderr; the wrapped cause's message + stack go
 * to the debug log, not to the terminal.
 */
class IdleStartupError extends Error {
  readonly userLine: string;
  constructor(userLine: string, cause?: unknown) {
    super(userLine, { cause });
    this.name = 'IdleStartupError';
    this.userLine = userLine;
  }
}

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version !== 'string') {
      throw new Error(`package.json at ${pkgPath} has no string "version" field`);
    }
    return parsed.version;
  } catch (err) {
    throw new IdleStartupError('could not read package version', err);
  }
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

function reportStartupFailure(err: unknown): void {
  if (err instanceof IdleStartupError) {
    process.stderr.write(`idle: ${err.userLine}\n`);
    log('error', 'idle startup failed', {
      userLine: err.userLine,
      cause:
        err.cause instanceof Error
          ? { message: err.cause.message, stack: err.cause.stack }
          : String(err.cause ?? ''),
    });
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`idle: startup failed — ${msg}\n`);
  log('error', 'idle startup failed', {
    message: msg,
    stack: err instanceof Error ? err.stack : undefined,
  });
}

async function main(argv: readonly string[]): Promise<void> {
  try {
    const program = buildProgram();
    await program.parseAsync(argv as string[]);
  } catch (err) {
    reportStartupFailure(err);
    process.exit(1);
  }
}

await main(process.argv);
