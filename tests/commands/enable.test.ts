import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { runEnable } from '../../src/commands/enable.js';

import { readToml, useCliSandbox } from './_harness.js';

const ctx = useCliSandbox('enable');

const TEST_CWD = '/Users/tester/projects/foo';

function writeConfig(body: string): void {
  mkdirSync(ctx.sandboxIdle, { recursive: true });
  writeFileSync(join(ctx.sandboxIdle, 'config.toml'), body);
}

let cwdSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(TEST_CWD);
});

afterEach(() => {
  cwdSpy?.mockRestore();
  cwdSpy = null;
});

describe('runEnable', () => {
  test('disabled config → becomes enabled, writes projects[cwd].enabled=true', () => {
    writeConfig(
      [
        '[projects]',
        `"${TEST_CWD}" = { enabled = false }`,
        '',
      ].join('\n'),
    );

    const code = runEnable();
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toBe(`Enabled for ${TEST_CWD}.\n`);
    expect(ctx.captured.stderr).toBe('');

    const config = readToml(join(ctx.sandboxIdle, 'config.toml')) as {
      projects?: Record<string, { enabled: boolean }>;
    };
    expect(config.projects?.[TEST_CWD]).toEqual({ enabled: true });
  });

  test('no config (implicitly enabled) → "Already enabled", no write', () => {
    const code = runEnable();
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toBe(`Already enabled for ${TEST_CWD}.\n`);
    expect(existsSync(join(ctx.sandboxIdle, 'config.toml'))).toBe(false);
  });

  test('explicitly-enabled config → "Already enabled", config preserved', () => {
    writeConfig(
      [
        '[projects]',
        `"${TEST_CWD}" = { enabled = true }`,
        '',
      ].join('\n'),
    );

    const code = runEnable();
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toBe(`Already enabled for ${TEST_CWD}.\n`);

    const config = readToml(join(ctx.sandboxIdle, 'config.toml')) as {
      projects?: Record<string, { enabled: boolean }>;
    };
    expect(config.projects?.[TEST_CWD]).toEqual({ enabled: true });
  });

  test('preserves other config fields and sibling project overrides', () => {
    const other = '/Users/tester/projects/bar';
    writeConfig(
      [
        '[thresholds]',
        'time_minutes = 90',
        'tool_calls = 100',
        '',
        '[tone]',
        'preset = "absurdist"',
        '',
        '[projects]',
        `"${TEST_CWD}" = { enabled = false }`,
        `"${other}" = { enabled = true }`,
        '',
      ].join('\n'),
    );

    const code = runEnable();
    expect(code).toBe(0);

    const config = readToml(join(ctx.sandboxIdle, 'config.toml')) as {
      thresholds?: { time_minutes: number; tool_calls: number };
      tone?: { preset: string };
      projects?: Record<string, { enabled: boolean }>;
    };
    expect(config.thresholds).toEqual({ time_minutes: 90, tool_calls: 100 });
    expect(config.tone).toEqual({ preset: 'absurdist' });
    expect(config.projects?.[TEST_CWD]).toEqual({ enabled: true });
    expect(config.projects?.[other]).toEqual({ enabled: true });
  });
});
