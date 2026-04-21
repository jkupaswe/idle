import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { runDisable } from '../../src/commands/disable.js';

import { readToml, useCliSandbox } from './_harness.js';

const ctx = useCliSandbox('disable');

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

describe('runDisable', () => {
  test('no config (implicitly enabled) → becomes disabled', () => {
    const code = runDisable();
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toBe(`Disabled for ${TEST_CWD}.\n`);
    expect(ctx.captured.stderr).toBe('');

    const config = readToml(join(ctx.sandboxIdle, 'config.toml')) as {
      projects?: Record<string, { enabled: boolean }>;
    };
    expect(config.projects?.[TEST_CWD]).toEqual({ enabled: false });
  });

  test('explicitly-enabled config → becomes disabled', () => {
    writeConfig(
      [
        '[projects]',
        `"${TEST_CWD}" = { enabled = true }`,
        '',
      ].join('\n'),
    );

    const code = runDisable();
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toBe(`Disabled for ${TEST_CWD}.\n`);

    const config = readToml(join(ctx.sandboxIdle, 'config.toml')) as {
      projects?: Record<string, { enabled: boolean }>;
    };
    expect(config.projects?.[TEST_CWD]).toEqual({ enabled: false });
  });

  test('already-disabled config → "Already disabled", config preserved', () => {
    writeConfig(
      [
        '[projects]',
        `"${TEST_CWD}" = { enabled = false }`,
        '',
      ].join('\n'),
    );

    const code = runDisable();
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toBe(`Already disabled for ${TEST_CWD}.\n`);

    const config = readToml(join(ctx.sandboxIdle, 'config.toml')) as {
      projects?: Record<string, { enabled: boolean }>;
    };
    expect(config.projects?.[TEST_CWD]).toEqual({ enabled: false });
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
        `"${other}" = { enabled = true }`,
        '',
      ].join('\n'),
    );

    const code = runDisable();
    expect(code).toBe(0);

    const config = readToml(join(ctx.sandboxIdle, 'config.toml')) as {
      thresholds?: { time_minutes: number; tool_calls: number };
      tone?: { preset: string };
      projects?: Record<string, { enabled: boolean }>;
    };
    expect(config.thresholds).toEqual({ time_minutes: 90, tool_calls: 100 });
    expect(config.tone).toEqual({ preset: 'absurdist' });
    expect(config.projects?.[TEST_CWD]).toEqual({ enabled: false });
    expect(config.projects?.[other]).toEqual({ enabled: true });
  });
});
