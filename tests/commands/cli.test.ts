/**
 * Smoke tests for the `idle` CLI dispatcher.
 *
 * Spawns the CLI as a child process via `node bin/idle` so the full
 * shebang → tsx → src/cli.ts → commander path is exercised. Tests isolate
 * filesystem side effects by pointing IDLE_HOME at a per-test tmpdir, even
 * though T-013's stubs do not touch the filesystem — later tickets will.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const binIdle = join(repoRoot, 'bin', 'idle');

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function runCli(args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  return runWith('node', [binIdle, ...args], env);
}

/**
 * Invoke bin/idle directly so the OS exercises the shebang. This catches
 * regressions the `node bin/idle` path misses: missing exec bit, broken
 * shebang, tsx/esm/api loader failure.
 */
async function runCliDirect(
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  return runWith(binIdle, [...args], env);
}

async function runWith(
  cmd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args as string[], {
      env: { ...process.env, ...env },
      timeout: 30_000,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      code: e.code ?? 1,
    };
  }
}

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'idle-cli-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('bin/idle shape', () => {
  test('is executable on disk', () => {
    const mode = statSync(binIdle).mode;
    expect(mode & 0o111).not.toBe(0);
  });

  test('direct-exec via shebang prints --version', async () => {
    const { stdout, stderr, code } = await runCliDirect(['--version'], { IDLE_HOME: sandbox });
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('idle --help', () => {
  test('lists every subcommand', async () => {
    const { stdout, code } = await runCli(['--help'], { IDLE_HOME: sandbox });
    expect(code).toBe(0);
    for (const cmd of [
      'init',
      'install',
      'uninstall',
      'stats',
      'status',
      'enable',
      'disable',
      'doctor',
    ]) {
      expect(stdout).toContain(cmd);
    }
  });

  test('prints the top-level description', async () => {
    const { stdout } = await runCli(['--help'], { IDLE_HOME: sandbox });
    expect(stdout).toContain('meters your tokens');
  });
});

describe('idle --version', () => {
  test('prints package.json version', async () => {
    const { stdout, code } = await runCli(['--version'], { IDLE_HOME: sandbox });
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('-v works as a short flag', async () => {
    const { stdout, code } = await runCli(['-v'], { IDLE_HOME: sandbox });
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('unknown command', () => {
  test('exits non-zero and complains to stderr', async () => {
    const { stderr, code } = await runCli(['bogus-subcommand'], { IDLE_HOME: sandbox });
    expect(code).not.toBe(0);
    expect(stderr.toLowerCase()).toMatch(/unknown|error/);
  });
});

describe('stubbed subcommands', () => {
  const subcommands = [
    'init',
    'install',
    'uninstall',
    'stats',
    'status',
    'enable',
    'disable',
    'doctor',
  ] as const;

  for (const name of subcommands) {
    test(`\`idle ${name}\` exits 1 with "not yet implemented"`, async () => {
      const { stderr, code } = await runCli([name], { IDLE_HOME: sandbox });
      expect(code).toBe(1);
      expect(stderr).toContain(`idle: ${name} not yet implemented`);
    });
  }
});
