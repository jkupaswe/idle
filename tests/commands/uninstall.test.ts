import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import prompts from 'prompts';
import { describe, expect, test } from 'vitest';

import { runInstall } from '../../src/commands/install.js';
import { runUninstall } from '../../src/commands/uninstall.js';

import { simulateMissingClaudeHome, useCliSandbox } from './_harness.js';

const ctx = useCliSandbox('uninstall');

describe('runUninstall', () => {
  test('no settings file → no-op message', async () => {
    const code = await runUninstall({});
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toBe(
      'No Claude Code settings file found; nothing to uninstall.\n',
    );
    expect(ctx.captured.stderr).toBe('');
    expect(existsSync(ctx.settingsPath)).toBe(false);
  });

  test('settings file with no Idle hooks → reports nothing to remove', async () => {
    const untouched = { hooks: { SessionStart: [] }, otherKey: 'keep' };
    writeFileSync(ctx.settingsPath, JSON.stringify(untouched, null, 2));

    const code = await runUninstall({});
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toBe('No Idle hooks found in settings.json.\n');
  });

  test('removes Idle hooks and reports backup path', async () => {
    await runInstall({});
    ctx.captured.stdout = '';
    ctx.captured.stderr = '';

    const code = await runUninstall({});
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toMatch(
      /^Uninstalled\. Previous settings backed up to .*\.idle-backup-.*\.\n$/,
    );

    const parsed = JSON.parse(readFileSync(ctx.settingsPath, 'utf8')) as {
      hooks?: unknown;
    };
    expect(parsed.hooks).toBeUndefined();
  });

  test('refuses to run when ~/.claude/ does not exist', async () => {
    const restore = simulateMissingClaudeHome(ctx);

    const code = await runUninstall({});
    expect(code).toBe(1);
    expect(ctx.captured.stderr).toContain('~/.claude/ not found');
    expect(ctx.captured.stdout).toBe('');

    restore();
  });
});

describe('runUninstall --purge', () => {
  test('confirm=true removes ~/.idle/', async () => {
    mkdirSync(ctx.sandboxIdle, { recursive: true });
    writeFileSync(join(ctx.sandboxIdle, 'config.toml'), '[tone]\npreset = "dry"\n');
    await runInstall({});
    ctx.captured.stdout = '';

    prompts.inject([true]);
    const code = await runUninstall({ purge: true });
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toContain('Uninstalled.');
    expect(ctx.captured.stdout).toContain('Purged ~/.idle/.');
    expect(existsSync(ctx.sandboxIdle)).toBe(false);
  });

  test('confirm=false leaves ~/.idle/ in place', async () => {
    mkdirSync(ctx.sandboxIdle, { recursive: true });
    writeFileSync(join(ctx.sandboxIdle, 'config.toml'), '[tone]\npreset = "dry"\n');
    await runInstall({});
    ctx.captured.stdout = '';

    prompts.inject([false]);
    const code = await runUninstall({ purge: true });
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toContain('Uninstalled.');
    expect(ctx.captured.stdout).toContain('Purge cancelled.');
    expect(existsSync(join(ctx.sandboxIdle, 'config.toml'))).toBe(true);
  });

  test('purge without existing ~/.idle/ is silent', async () => {
    rmSync(ctx.sandboxIdle, { recursive: true, force: true });

    const code = await runUninstall({ purge: true });
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toContain(
      'No Claude Code settings file found; nothing to uninstall.',
    );
    expect(ctx.captured.stdout).not.toContain('Purged');
    expect(ctx.captured.stdout).not.toContain('Purge cancelled');

    mkdirSync(ctx.sandboxIdle, { recursive: true });
  });
});
