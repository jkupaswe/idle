import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { runInstall } from '../../src/commands/install.js';
import { IDLE_TAG } from '../../src/core/settings.js';

import { readToml, simulateMissingClaudeHome, useCliSandbox } from './_harness.js';

const ctx = useCliSandbox('install');

function writeCustomConfig(): void {
  const customized = [
    '[thresholds]',
    'time_minutes = 90',
    'tool_calls = 20',
    '',
    '[tone]',
    'preset = "absurdist"',
    '',
    '[notifications]',
    'method = "both"',
    'sound = true',
    '',
  ].join('\n');
  mkdirSync(ctx.sandboxIdle, { recursive: true });
  writeFileSync(join(ctx.sandboxIdle, 'config.toml'), customized);
}

describe('runInstall', () => {
  test('writes default config and installs hooks on first run', async () => {
    const code = await runInstall({});
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toBe('Installed.\n');
    expect(ctx.captured.stderr).toBe('');

    const config = readToml(join(ctx.sandboxIdle, 'config.toml'));
    expect(config).toMatchObject({
      thresholds: { time_minutes: 45, tool_calls: 40 },
      tone: { preset: 'dry' },
      notifications: { method: 'native', sound: false },
    });
    expect(readFileSync(ctx.settingsPath, 'utf8')).toContain(IDLE_TAG);
  });

  test('--defaults on a fresh install emits "Installed." (no reset note)', async () => {
    const code = await runInstall({ defaults: true });
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toBe('Installed.\n');
  });

  test('--defaults overwrites an existing config with reset note', async () => {
    writeCustomConfig();

    const code = await runInstall({ defaults: true });
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toBe('Installed. Config reset to defaults.\n');

    const config = readToml(join(ctx.sandboxIdle, 'config.toml'));
    expect(config).toMatchObject({
      thresholds: { time_minutes: 45, tool_calls: 40 },
      tone: { preset: 'dry' },
      notifications: { method: 'native', sound: false },
    });
  });

  test('without --defaults, preserves an existing valid config with preserved note', async () => {
    writeCustomConfig();

    const code = await runInstall({});
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toBe(
      'Installed. Existing config preserved.\n',
    );

    const config = readToml(join(ctx.sandboxIdle, 'config.toml'));
    expect(config).toMatchObject({
      thresholds: { time_minutes: 90, tool_calls: 20 },
      tone: { preset: 'absurdist' },
      notifications: { method: 'both', sound: true },
    });
  });

  test('reports backup path on fresh install when settings.json pre-exists', async () => {
    writeFileSync(ctx.settingsPath, JSON.stringify({ keep: true }, null, 2));

    const code = await runInstall({});
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toMatch(
      /^Installed\. Previous settings backed up to .*\.idle-backup-.*\.\n$/,
    );
  });

  test('preserved config + settings backup combines both notes', async () => {
    writeCustomConfig();
    writeFileSync(ctx.settingsPath, JSON.stringify({ keep: true }, null, 2));

    const code = await runInstall({});
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toMatch(
      /^Installed\. Existing config preserved\. Previous settings backed up to .*\.idle-backup-.*\.\n$/,
    );
  });

  test('--defaults + settings backup combines reset note and backup note', async () => {
    writeCustomConfig();
    writeFileSync(ctx.settingsPath, JSON.stringify({ keep: true }, null, 2));

    const code = await runInstall({ defaults: true });
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toMatch(
      /^Installed\. Config reset to defaults\. Previous settings backed up to .*\.idle-backup-.*\.\n$/,
    );
  });

  test('refuses to run when ~/.claude/ does not exist', async () => {
    const restore = simulateMissingClaudeHome(ctx);

    const code = await runInstall({});
    expect(code).toBe(1);
    expect(ctx.captured.stderr).toContain('~/.claude/ not found');
    expect(ctx.captured.stdout).toBe('');
    expect(existsSync(join(ctx.sandboxIdle, 'config.toml'))).toBe(false);

    restore();
  });

  test('refuses to run when `claude` is not on PATH (PRD §6.1)', async () => {
    ctx.removeClaudeFromPath();

    const code = await runInstall({});
    expect(code).toBe(1);
    expect(ctx.captured.stderr).toContain('claude not found on PATH');
    expect(ctx.captured.stdout).toBe('');
    expect(existsSync(join(ctx.sandboxIdle, 'config.toml'))).toBe(false);
  });

  test('refuses to run when an internal hook script is a directory, not a file', async () => {
    // Reproduce Codex round 3 finding 4: ensureHookScriptsPresent
    // previously used existsSync and would accept a directory named
    // stop.ts. Now requires statSync().isFile().
    ctx.removeHookScript('stop.ts');
    mkdirSync(join(ctx.sandboxHooks, 'stop.ts'));

    const code = await runInstall({});
    expect(code).toBe(1);
    expect(ctx.captured.stderr).toMatch(
      /idle is missing an internal hook script: .*stop\.ts/,
    );
    expect(existsSync(join(ctx.sandboxIdle, 'config.toml'))).toBe(false);
  });

  test('refuses to run when `claude` on PATH is a directory, not an executable', async () => {
    // Reproduce Codex round 3 finding 4: claudeOnPath previously used
    // accessSync(X_OK) which accepts searchable directories. Now
    // requires statSync().isFile().
    rmSync(join(ctx.sandboxBin, 'claude'));
    mkdirSync(join(ctx.sandboxBin, 'claude'));

    const code = await runInstall({});
    expect(code).toBe(1);
    expect(ctx.captured.stderr).toContain('claude not found on PATH');
  });

  test('refuses to run when an internal hook script is missing', async () => {
    ctx.removeHookScript('stop.ts');

    const code = await runInstall({});
    expect(code).toBe(1);
    expect(ctx.captured.stderr).toMatch(
      /idle is missing an internal hook script: .*stop\.ts/,
    );
    expect(ctx.captured.stdout).toBe('');
    expect(existsSync(join(ctx.sandboxIdle, 'config.toml'))).toBe(false);
    expect(existsSync(ctx.settingsPath)).toBe(false);
  });

  test('settings.json failure does not leave a stray config.toml (PRD §6.1)', async () => {
    writeFileSync(ctx.settingsPath, 'this is {not valid json at all');

    const code = await runInstall({});
    expect(code).toBe(1);
    expect(ctx.captured.stderr).toContain('Could not read');
    expect(existsSync(join(ctx.sandboxIdle, 'config.toml'))).toBe(false);
  });

  test('prints a clean error when the existing config is malformed', async () => {
    mkdirSync(ctx.sandboxIdle, { recursive: true });
    writeFileSync(join(ctx.sandboxIdle, 'config.toml'), 'garbage = = broken');

    const code = await runInstall({});
    expect(code).toBe(1);
    expect(ctx.captured.stderr).toContain('Failed to parse TOML config');
    expect(ctx.captured.stderr).toContain('install --defaults');
    expect(existsSync(ctx.settingsPath)).toBe(false);
  });

  test('refuses to proceed when state.json exists as a directory', async () => {
    mkdirSync(join(ctx.sandboxIdle, 'state.json'), { recursive: true });
    await expect(runInstall({})).rejects.toThrow(
      /state\.json exists but is not a regular file/,
    );
  });

  test('refuses to proceed when debug.log exists as a directory', async () => {
    mkdirSync(join(ctx.sandboxIdle, 'debug.log'), { recursive: true });
    await expect(runInstall({})).rejects.toThrow(
      /debug\.log exists but is not a regular file/,
    );
  });

  test('refuses to proceed when sessions/ exists as a file', async () => {
    mkdirSync(ctx.sandboxIdle, { recursive: true });
    writeFileSync(join(ctx.sandboxIdle, 'sessions'), 'not a dir');
    await expect(runInstall({})).rejects.toThrow(
      /sessions exists but is not a directory/,
    );
  });

  test('fresh install provisions all runtime files (Decision UU, PRD §6.1)', async () => {
    const code = await runInstall({});
    expect(code).toBe(0);

    expect(existsSync(join(ctx.sandboxIdle, 'config.toml'))).toBe(true);
    expect(existsSync(join(ctx.sandboxIdle, 'state.json'))).toBe(true);
    expect(existsSync(join(ctx.sandboxIdle, 'sessions'))).toBe(true);
    expect(existsSync(join(ctx.sandboxIdle, 'debug.log'))).toBe(true);

    const state = JSON.parse(
      readFileSync(join(ctx.sandboxIdle, 'state.json'), 'utf8'),
    ) as { sessions: unknown };
    expect(state.sessions).toEqual({});
  });

  test('re-install preserves existing state.json content', async () => {
    mkdirSync(ctx.sandboxIdle, { recursive: true });
    const preserved = JSON.stringify(
      { sessions: { 'sess_abc': { marker: 'keep me' } } },
      null,
      2,
    );
    writeFileSync(join(ctx.sandboxIdle, 'state.json'), preserved);

    const code = await runInstall({});
    expect(code).toBe(0);
    expect(readFileSync(join(ctx.sandboxIdle, 'state.json'), 'utf8')).toBe(
      preserved,
    );
  });

  test('re-install does not truncate existing debug.log', async () => {
    mkdirSync(ctx.sandboxIdle, { recursive: true });
    const history = 'line 1\nline 2\n';
    writeFileSync(join(ctx.sandboxIdle, 'debug.log'), history);

    const code = await runInstall({});
    expect(code).toBe(0);
    expect(readFileSync(join(ctx.sandboxIdle, 'debug.log'), 'utf8')).toBe(
      history,
    );
  });

  test('re-install re-creates runtime files the user deleted', async () => {
    await runInstall({});
    rmSync(join(ctx.sandboxIdle, 'state.json'));
    rmSync(join(ctx.sandboxIdle, 'debug.log'));
    rmSync(join(ctx.sandboxIdle, 'sessions'), { recursive: true });

    const code = await runInstall({});
    expect(code).toBe(0);
    expect(existsSync(join(ctx.sandboxIdle, 'state.json'))).toBe(true);
    expect(existsSync(join(ctx.sandboxIdle, 'sessions'))).toBe(true);
    expect(existsSync(join(ctx.sandboxIdle, 'debug.log'))).toBe(true);
  });

  test('is idempotent: second install preserves config and leaves one copy of each Idle hook', async () => {
    await runInstall({});
    ctx.captured.stdout = '';
    const code = await runInstall({});
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toMatch(
      /^Installed\. Existing config preserved\. Previous settings backed up to .*\.idle-backup-.*\.\n$/,
    );

    const parsed = JSON.parse(readFileSync(ctx.settingsPath, 'utf8')) as {
      hooks: Record<
        string,
        Array<{ matcher: string; hooks: Array<{ command: string }> }>
      >;
    };
    for (const event of Object.values(parsed.hooks)) {
      const idleCmds = event
        .flatMap((g) => g.hooks)
        .filter((h) => h.command.includes(IDLE_TAG));
      expect(idleCmds.length).toBe(1);
    }
  });
});
