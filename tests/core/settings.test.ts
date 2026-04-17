import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  IDLE_EVENTS,
  IDLE_HOOK_EVENTS,
  IDLE_TAG,
  installHooks,
  uninstallHooks,
} from '../../src/core/settings.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'idle-settings-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function settingsPath(): string {
  return join(tmp, 'settings.json');
}

function hooksDir(): string {
  return join(tmp, 'stub-hooks');
}

function install() {
  return installHooks({
    settingsPath: settingsPath(),
    hooksDir: hooksDir(),
  });
}

function uninstall() {
  return uninstallHooks({ settingsPath: settingsPath() });
}

function readJson<T = unknown>(p: string): T {
  return JSON.parse(readFileSync(p, 'utf8')) as T;
}

describe('installHooks', () => {
  test('creates settings.json with four Idle hooks when file is missing', () => {
    const result = install();
    expect(result.backupPath).toBeNull();

    const settings = readJson<{
      hooks: Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>;
    }>(settingsPath());
    for (const event of IDLE_EVENTS) {
      const group = settings.hooks[event]?.find((g) => g.matcher === '');
      expect(group, `event=${event}`).toBeDefined();
      const idle = group!.hooks.find((h) => h.command.includes(IDLE_TAG));
      expect(idle, `event=${event}`).toBeDefined();
      expect(idle!.command).toMatch(/^npx tsx /);
    }
  });

  test('preserves user hooks and unrelated top-level keys', () => {
    const original = {
      apiKeyHelper: '/usr/local/bin/my-helper',
      permissions: { allow: ['Bash(ls)'] },
      hooks: {
        PostToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'user-bash-hook.sh' }],
          },
        ],
        UserPromptSubmit: [
          {
            matcher: '',
            hooks: [{ type: 'command', command: 'user-prompt-hook.sh' }],
          },
        ],
      },
    };
    writeFileSync(settingsPath(), JSON.stringify(original, null, 2));

    install();
    const after = readJson<typeof original>(settingsPath());
    expect(after.apiKeyHelper).toBe(original.apiKeyHelper);
    expect(after.permissions).toEqual(original.permissions);
    expect(after.hooks.UserPromptSubmit).toEqual(original.hooks.UserPromptSubmit);
    const bashGroup = after.hooks.PostToolUse!.find((g) => g.matcher === 'Bash');
    expect(bashGroup?.hooks[0]?.command).toBe('user-bash-hook.sh');
  });

  test('writes a timestamped backup when settings.json pre-exists', () => {
    const original = { hooks: {} };
    writeFileSync(settingsPath(), JSON.stringify(original));

    const result = install();
    expect(result.backupPath).toMatch(/\.idle-backup-/);
    expect(existsSync(result.backupPath!)).toBe(true);
    const backup = JSON.parse(readFileSync(result.backupPath!, 'utf8'));
    expect(backup).toEqual(original);
  });

  test('is idempotent — running install twice is equivalent to once', () => {
    install();
    const once = readJson<unknown>(settingsPath());

    install();
    const twice = readJson<unknown>(settingsPath());

    expect(twice).toEqual(once);
  });

  test('rejects a malformed JSON settings file', () => {
    writeFileSync(settingsPath(), '{not valid json');
    expect(() => install()).toThrow(/Failed to parse Claude Code settings/);
  });

  test('leaves no .tmp artifact after write', () => {
    install();
    const stray = readdirSync(tmp).find((e) => e.includes('.tmp-'));
    expect(stray).toBeUndefined();
  });
});

describe('uninstallHooks', () => {
  test('install then uninstall round-trips byte-identically (JSON-normalized)', () => {
    const original = {
      apiKeyHelper: '/usr/local/bin/my-helper',
      permissions: { allow: ['Bash(ls)'] },
      hooks: {
        PostToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'user-bash-hook.sh' }],
          },
        ],
        UserPromptSubmit: [
          {
            matcher: '',
            hooks: [{ type: 'command', command: 'user-prompt-hook.sh' }],
          },
        ],
      },
    };
    writeFileSync(settingsPath(), JSON.stringify(original, null, 2));

    install();
    const result = uninstall();
    expect(result.removed).toBe(IDLE_EVENTS.length);

    const after = readJson<unknown>(settingsPath());
    expect(after).toEqual(original);
  });

  test('removes only Idle hooks and leaves empty groups collapsed', () => {
    install();
    const result = uninstall();
    expect(result.removed).toBe(IDLE_EVENTS.length);
    const after = readJson<{ hooks?: unknown }>(settingsPath());
    // No prior user hooks → the `hooks` key should be gone entirely.
    expect(after.hooks).toBeUndefined();
  });

  test('preserves user hooks that share a matcher with Idle', () => {
    // Pre-seed a user Stop hook that already uses matcher "".
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              matcher: '',
              hooks: [{ type: 'command', command: 'user-stop.sh' }],
            },
          ],
        },
      }),
    );
    install();
    uninstall();
    const after = readJson<{
      hooks: {
        Stop: Array<{ matcher: string; hooks: Array<{ command: string }> }>;
      };
    }>(settingsPath());
    expect(after.hooks.Stop).toHaveLength(1);
    expect(after.hooks.Stop[0]!.hooks[0]!.command).toBe('user-stop.sh');
  });

  test('uninstall is safe on a file that never had Idle installed', () => {
    const original = {
      hooks: {
        PostToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'user-bash.sh' }],
          },
        ],
      },
    };
    writeFileSync(settingsPath(), JSON.stringify(original, null, 2));
    const result = uninstall();
    expect(result.removed).toBe(0);
    expect(readJson(settingsPath())).toEqual(original);
  });

  test('uninstall on a missing file creates an empty object, no backup', () => {
    const result = uninstall();
    expect(result.backupPath).toBeNull();
    expect(readJson(settingsPath())).toEqual({});
  });
});

describe('hook command format', () => {
  test('commands include the Idle tag and point at the expected script', () => {
    install();
    const settings = readJson<{
      hooks: Record<
        string,
        Array<{ matcher: string; hooks: Array<{ command: string }> }>
      >;
    }>(settingsPath());

    for (const hook of IDLE_HOOK_EVENTS) {
      const group = settings.hooks[hook.event]!.find((g) => g.matcher === '')!;
      const cmd = group.hooks.find((h) => h.command.includes(IDLE_TAG))!.command;
      expect(cmd).toMatch(
        new RegExp(`${hook.script} ${IDLE_TAG.replace('#', '\\#')}$`),
      );
      expect(cmd.startsWith('npx tsx ')).toBe(true);
    }
  });
});

describe('async flag per event', () => {
  test('SessionStart / PostToolUse / SessionEnd emit async: true; Stop stays synchronous', () => {
    install();
    const settings = readJson<{
      hooks: Record<
        string,
        Array<{
          matcher: string;
          hooks: Array<{ command: string; async?: boolean }>;
        }>
      >;
    }>(settingsPath());

    for (const hook of IDLE_HOOK_EVENTS) {
      const group = settings.hooks[hook.event]!.find((g) => g.matcher === '')!;
      const idle = group.hooks.find((h) => h.command.includes(IDLE_TAG))!;

      if (hook.async) {
        expect(idle.async, `${hook.event} must be async`).toBe(true);
      } else {
        // Stop: sync. Field omitted (Claude Code's default).
        expect(idle.async).toBeUndefined();
      }
    }
  });
});
