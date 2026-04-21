import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import prompts from 'prompts';
import { describe, expect, test } from 'vitest';

import { runInit, validateThreshold } from '../../src/commands/init.js';
import { IDLE_TAG } from '../../src/core/settings.js';

import { readToml, simulateMissingClaudeHome, useCliSandbox } from './_harness.js';

const ctx = useCliSandbox('init');

describe('runInit', () => {
  test('happy path: writes config and installs hooks', async () => {
    prompts.inject(['dry', 45, 40, 'native', true]);

    const code = await runInit();
    expect(code).toBe(0);
    expect(ctx.captured.stderr).toBe('');
    expect(ctx.captured.stdout).toMatch(/^Installed\.\n$/);

    const config = readToml(join(ctx.sandboxIdle, 'config.toml'));
    expect(config).toMatchObject({
      thresholds: { time_minutes: 45, tool_calls: 40 },
      tone: { preset: 'dry' },
      notifications: { method: 'native', sound: false },
    });

    expect(existsSync(ctx.settingsPath)).toBe(true);
    expect(readFileSync(ctx.settingsPath, 'utf8')).toContain(IDLE_TAG);
  });

  test('records custom prompt values in config', async () => {
    prompts.inject(['absurdist', 90, 20, 'both', true]);

    const code = await runInit();
    expect(code).toBe(0);

    const config = readToml(join(ctx.sandboxIdle, 'config.toml'));
    expect(config).toMatchObject({
      thresholds: { time_minutes: 90, tool_calls: 20 },
      tone: { preset: 'absurdist' },
      notifications: { method: 'both', sound: false },
    });
  });

  test('reports the backup path when settings.json already exists', async () => {
    writeFileSync(ctx.settingsPath, JSON.stringify({ otherKey: true }, null, 2));
    prompts.inject(['dry', 45, 40, 'native', true]);

    const code = await runInit();
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toMatch(
      /^Installed\. Previous settings backed up to .*\.idle-backup-.*\.\n$/,
    );
  });

  test('declining the confirm prints "Cancelled." and writes nothing', async () => {
    prompts.inject(['dry', 45, 40, 'native', false]);

    const code = await runInit();
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toBe('Cancelled.\n');
    expect(ctx.captured.stderr).toBe('');
    expect(existsSync(join(ctx.sandboxIdle, 'config.toml'))).toBe(false);
    expect(existsSync(ctx.settingsPath)).toBe(false);
  });

  test('cancelling mid-flow prints "Cancelled." and writes nothing', async () => {
    prompts.inject(['dry', new Error('abort')]);

    const code = await runInit();
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toBe('Cancelled.\n');
    expect(existsSync(join(ctx.sandboxIdle, 'config.toml'))).toBe(false);
    expect(existsSync(ctx.settingsPath)).toBe(false);
  });

  test('refuses to run when ~/.claude/ does not exist', async () => {
    const restore = simulateMissingClaudeHome(ctx);
    prompts.inject(['dry', 45, 40, 'native', true]);

    const code = await runInit();
    expect(code).toBe(1);
    expect(ctx.captured.stderr).toContain('~/.claude/ not found');
    expect(ctx.captured.stdout).toBe('');

    restore();
  });

  test('refuses to run when `claude` is not on PATH', async () => {
    ctx.removeClaudeFromPath();
    prompts.inject(['dry', 45, 40, 'native', true]);

    const code = await runInit();
    expect(code).toBe(1);
    expect(ctx.captured.stderr).toContain('claude not found on PATH');
    expect(existsSync(join(ctx.sandboxIdle, 'config.toml'))).toBe(false);
  });

  test('refuses to run when an internal hook script is missing', async () => {
    ctx.removeHookScript('stop.ts');
    prompts.inject(['dry', 45, 40, 'native', true]);

    const code = await runInit();
    expect(code).toBe(1);
    expect(ctx.captured.stderr).toMatch(
      /idle is missing an internal hook script: .*stop\.ts/,
    );
    expect(existsSync(join(ctx.sandboxIdle, 'config.toml'))).toBe(false);
  });

  test('happy path provisions PRD §6.1 runtime files (Decision UU)', async () => {
    prompts.inject(['dry', 45, 40, 'native', true]);

    const code = await runInit();
    expect(code).toBe(0);
    expect(existsSync(join(ctx.sandboxIdle, 'config.toml'))).toBe(true);
    expect(existsSync(join(ctx.sandboxIdle, 'state.json'))).toBe(true);
    expect(existsSync(join(ctx.sandboxIdle, 'sessions'))).toBe(true);
    expect(existsSync(join(ctx.sandboxIdle, 'debug.log'))).toBe(true);
  });

  test('install failure leaves no stray config.toml behind (PRD §6.1)', async () => {
    writeFileSync(ctx.settingsPath, 'not json {');
    prompts.inject(['absurdist', 90, 20, 'both', true]);

    const code = await runInit();
    expect(code).toBe(1);
    expect(ctx.captured.stderr).toContain('Could not read');
    expect(existsSync(join(ctx.sandboxIdle, 'config.toml'))).toBe(false);
  });

  test('Decision VV: injected decimal threshold is rejected and rolled back', async () => {
    // prompts.inject() skips prompt-level validation, so this exercises
    // the saveConfig defense — proves the decimal doesn't survive to
    // the state layer. Real interactive runs are caught earlier by the
    // validator (see validateThreshold unit test below).
    prompts.inject(['dry', 1.5, 40, 'native', true]);

    const code = await runInit();
    expect(code).toBe(1);
    expect(ctx.captured.stderr).toMatch(
      /install failed after hooks were registered.*thresholds\.time_minutes/,
    );
    // No pre-existing settings.json → rollback unlinks what install wrote.
    expect(existsSync(ctx.settingsPath)).toBe(false);
  });
});

describe('validateThreshold (Decision VV)', () => {
  test('accepts integers', () => {
    expect(validateThreshold(0)).toBe(true);
    expect(validateThreshold(45)).toBe(true);
    expect(validateThreshold(9999)).toBe(true);
  });

  test('rejects non-integer input with a terse message', () => {
    expect(validateThreshold(1.5)).toBe('Enter a whole number.');
    expect(validateThreshold(2.3)).toBe('Enter a whole number.');
    expect(validateThreshold(Math.PI)).toBe('Enter a whole number.');
  });
});
