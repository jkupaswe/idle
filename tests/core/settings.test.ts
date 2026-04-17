import {
  chmodSync,
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
  buildHookCommand,
  IDLE_EVENTS,
  IDLE_HOOK_EVENTS,
  IDLE_TAG,
  installHooks,
  isIdleOwnedCommand,
  resolveHooksDirFromModule,
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
  test('creates settings.json with four Idle hooks when file is missing', async () => {
    const result = await install();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.backupPath).toBeNull();
    expect(result.installedEvents).toEqual([...IDLE_EVENTS]);

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

  test('returns ok:false reason=claude_not_installed when ~/.claude is missing', async () => {
    const missingDir = join(tmp, 'does-not-exist', 'settings.json');
    const r = await installHooks({
      settingsPath: missingDir,
      hooksDir: hooksDir(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('claude_not_installed');
      expect(r.detail).toMatch(/Claude Code home directory/);
    }
    expect(existsSync(missingDir)).toBe(false);
  });

  test('preserves user hooks and unrelated top-level keys', async () => {
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

    await install();
    const after = readJson<typeof original>(settingsPath());
    expect(after.apiKeyHelper).toBe(original.apiKeyHelper);
    expect(after.permissions).toEqual(original.permissions);
    expect(after.hooks.UserPromptSubmit).toEqual(original.hooks.UserPromptSubmit);
    const bashGroup = after.hooks.PostToolUse!.find((g) => g.matcher === 'Bash');
    expect(bashGroup?.hooks[0]?.command).toBe('user-bash-hook.sh');
  });

  test('writes a timestamped backup when settings.json pre-exists', async () => {
    const original = { hooks: {} };
    writeFileSync(settingsPath(), JSON.stringify(original));

    const result = await install();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.backupPath).toMatch(/\.idle-backup-/);
    expect(existsSync(result.backupPath!)).toBe(true);
    const backup = JSON.parse(readFileSync(result.backupPath!, 'utf8'));
    expect(backup).toEqual(original);
  });

  test('is idempotent — running install twice is equivalent to once', async () => {
    await install();
    const once = readJson<unknown>(settingsPath());

    await install();
    const twice = readJson<unknown>(settingsPath());

    expect(twice).toEqual(once);
  });

  test('returns ok:false reason=malformed_settings on invalid JSON', async () => {
    writeFileSync(settingsPath(), '{not valid json');
    const r = await install();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('malformed_settings');
      expect(r.detail).toMatch(/parse/i);
    }
  });

  test('leaves no .tmp artifact after write', async () => {
    await install();
    const stray = readdirSync(tmp).find((e) => e.includes('.tmp-'));
    expect(stray).toBeUndefined();
  });
});

describe('uninstallHooks', () => {
  test('install then uninstall round-trips byte-identically (JSON-normalized)', async () => {
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

    await install();
    const result = await uninstall();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.removedEvents).toEqual([...IDLE_EVENTS]);

    const after = readJson<unknown>(settingsPath());
    expect(after).toEqual(original);
  });

  test('removes only Idle hooks and leaves empty groups collapsed', async () => {
    await install();
    const result = await uninstall();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.removedEvents).toEqual([...IDLE_EVENTS]);
    expect(result.fileExisted).toBe(true);
    const after = readJson<{ hooks?: unknown }>(settingsPath());
    // No prior user hooks → the `hooks` key should be gone entirely.
    expect(after.hooks).toBeUndefined();
  });

  test('preserves user hooks that share a matcher with Idle', async () => {
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
    await install();
    await uninstall();
    const after = readJson<{
      hooks: {
        Stop: Array<{ matcher: string; hooks: Array<{ command: string }> }>;
      };
    }>(settingsPath());
    expect(after.hooks.Stop).toHaveLength(1);
    expect(after.hooks.Stop[0]!.hooks[0]!.command).toBe('user-stop.sh');
  });

  test('uninstall is safe on a file that never had Idle installed', async () => {
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
    const result = await uninstall();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.removedEvents).toEqual([]);
    expect(result.fileExisted).toBe(true);
    expect(readJson(settingsPath())).toEqual(original);
  });

  test('uninstall on a missing file is a true no-op: fileExisted=false, no write', async () => {
    const result = await uninstall();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.fileExisted).toBe(false);
    expect(result.backupPath).toBeNull();
    expect(result.removedEvents).toEqual([]);
    // PRD §6.1 "restore exact prior state": the file must NOT be
    // manufactured by uninstall.
    expect(existsSync(settingsPath())).toBe(false);
  });
});

describe('hook command format', () => {
  test('commands are single-quoted, include the Idle tag, and point at the expected script', async () => {
    await install();
    const settings = readJson<{
      hooks: Record<
        string,
        Array<{ matcher: string; hooks: Array<{ command: string }> }>
      >;
    }>(settingsPath());

    for (const hook of IDLE_HOOK_EVENTS) {
      const group = settings.hooks[hook.event]!.find((g) => g.matcher === '')!;
      const cmd = group.hooks.find((h) => h.command.includes(IDLE_TAG))!.command;
      // Expect: `npx tsx '<abspath/<script>' # idle:v1`
      expect(cmd).toMatch(
        new RegExp(`${hook.script}' ${IDLE_TAG.replace('#', '\\#')}$`),
      );
      expect(cmd.startsWith('npx tsx \'')).toBe(true);
      // And the predicate recognizes it.
      expect(isIdleOwnedCommand(cmd)).toBe(true);
    }
  });
});

describe('isIdleOwnedCommand predicate', () => {
  test('accepts Idle-emitted commands (unquoted path)', async () => {
    expect(
      isIdleOwnedCommand(
        `npx tsx /path/to/session-start.ts ${IDLE_TAG}`,
      ),
    ).toBe(true);
    expect(
      isIdleOwnedCommand(
        `npx tsx /abs/path/stop.ts ${IDLE_TAG}`,
      ),
    ).toBe(true);
  });

  test('accepts Idle-emitted commands (single-quoted path with spaces)', async () => {
    expect(
      isIdleOwnedCommand(
        `npx tsx '/Users/Alice Smith/idle/hooks/post-tool-use.ts' ${IDLE_TAG}`,
      ),
    ).toBe(true);
  });

  test('rejects a user command that mentions the tag as a substring', async () => {
    expect(
      isIdleOwnedCommand('echo keep me # idle:v1 but not idle'),
    ).toBe(false);
  });

  test('rejects a user command that ends with the tag but is not ours', async () => {
    expect(
      isIdleOwnedCommand(`bash /home/bob/mine.sh ${IDLE_TAG}`),
    ).toBe(false);
    expect(
      isIdleOwnedCommand(`npx tsx /unrelated/not-idle.ts ${IDLE_TAG}`),
    ).toBe(false);
  });

  test('rejects commands missing the prefix or suffix', async () => {
    expect(
      isIdleOwnedCommand(`/path/to/stop.ts ${IDLE_TAG}`),
    ).toBe(false);
    expect(
      isIdleOwnedCommand('npx tsx /path/to/stop.ts'),
    ).toBe(false);
    expect(isIdleOwnedCommand('')).toBe(false);
  });

  test('rejects trailing garbage after the tag', async () => {
    expect(
      isIdleOwnedCommand(`npx tsx /path/stop.ts ${IDLE_TAG} oops`),
    ).toBe(false);
  });
});

describe('uninstall: tightened ownership detection', () => {
  test("user hook containing the tag in its body is preserved", async () => {
    // Author's command mentions the marker text but is not Idle's.
    const userHook = `echo "owned by me # idle:v1 but not idle"`;
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              matcher: '',
              hooks: [{ type: 'command', command: userHook }],
            },
          ],
        },
      }),
    );

    await install(); // Adds Idle's Stop hook alongside the user's.
    const result = await uninstall();
    expect(result.ok).toBe(true);

    const after = readJson<{
      hooks: {
        Stop: Array<{ matcher: string; hooks: Array<{ command: string }> }>;
      };
    }>(settingsPath());
    expect(after.hooks.Stop).toHaveLength(1);
    expect(after.hooks.Stop[0]!.hooks[0]!.command).toBe(userHook);
  });

  test('user hook with trailing tag but wrong binary is preserved', async () => {
    const userHook = `bash /home/bob/mine.sh ${IDLE_TAG}`;
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: '',
              hooks: [{ type: 'command', command: userHook }],
            },
          ],
        },
      }),
    );

    await install();
    await uninstall();

    const after = readJson<{
      hooks: {
        SessionStart: Array<{
          matcher: string;
          hooks: Array<{ command: string }>;
        }>;
      };
    }>(settingsPath());
    expect(after.hooks.SessionStart[0]!.hooks[0]!.command).toBe(userHook);
  });
});

describe('resolveHooksDirFromModule', () => {
  test('resolves to <pkg>/src/hooks whether called from src/ or dist/', async () => {
    const fromSrc = resolveHooksDirFromModule('/pkg/src/core/settings.ts');
    const fromDist = resolveHooksDirFromModule('/pkg/dist/core/settings.js');
    expect(fromSrc).toBe('/pkg/src/hooks');
    expect(fromDist).toBe('/pkg/src/hooks');
  });

  test('never points at dist/hooks (files there are .js, not .ts)', async () => {
    const resolved = resolveHooksDirFromModule('/opt/idle/dist/core/settings.js');
    expect(resolved).not.toMatch(/dist\/hooks$/);
    expect(resolved).toMatch(/src\/hooks$/);
  });
});

describe('buildHookCommand (shell escaping)', () => {
  test('plain POSIX path wraps in single quotes', async () => {
    const cmd = buildHookCommand('stop.ts', '/home/alice/idle/hooks');
    expect(cmd).toBe(
      `npx tsx '/home/alice/idle/hooks/stop.ts' ${IDLE_TAG}`,
    );
    expect(isIdleOwnedCommand(cmd)).toBe(true);
  });

  test('path with spaces', async () => {
    const cmd = buildHookCommand(
      'post-tool-use.ts',
      '/Users/Alice Smith/idle/hooks',
    );
    expect(cmd).toBe(
      `npx tsx '/Users/Alice Smith/idle/hooks/post-tool-use.ts' ${IDLE_TAG}`,
    );
    expect(isIdleOwnedCommand(cmd)).toBe(true);
  });

  test('path with a single quote is POSIX-escaped', async () => {
    const cmd = buildHookCommand(
      'session-start.ts',
      "/home/d'angelo/hooks",
    );
    // Single quote in the path becomes `'\''`
    expect(cmd).toBe(
      `npx tsx '/home/d'\\''angelo/hooks/session-start.ts' ${IDLE_TAG}`,
    );
    expect(isIdleOwnedCommand(cmd)).toBe(true);
  });

  test('path with shell metacharacters is inert inside single quotes', async () => {
    const cmd = buildHookCommand(
      'session-end.ts',
      '/weird/$path with`cmd`/and*glob',
    );
    expect(cmd).toBe(
      `npx tsx '/weird/$path with\`cmd\`/and*glob/session-end.ts' ${IDLE_TAG}`,
    );
    expect(isIdleOwnedCommand(cmd)).toBe(true);
  });

  test('install+uninstall round-trips with a hooks dir containing spaces and quotes', async () => {
    // mkdtemp gives a simple path; construct a spacey hooksDir.
    const spacey = join(tmp, "has space and 'quote'");
    const result = await installHooks({
      settingsPath: settingsPath(),
      hooksDir: spacey,
    });
    expect(result.ok).toBe(true);

    // Commands all pass the predicate.
    const settings = readJson<{
      hooks: Record<
        string,
        Array<{ matcher: string; hooks: Array<{ command: string }> }>
      >;
    }>(settingsPath());
    for (const hook of IDLE_HOOK_EVENTS) {
      const group = settings.hooks[hook.event]!.find((g) => g.matcher === '')!;
      const cmd = group.hooks.find((h) => h.command.includes(IDLE_TAG))!.command;
      expect(isIdleOwnedCommand(cmd)).toBe(true);
    }

    // Uninstall removes them all cleanly.
    const uninstallResult = await uninstall();
    expect(uninstallResult.ok).toBe(true);
    if (!uninstallResult.ok) throw new Error('unreachable');
    expect(uninstallResult.removedEvents).toEqual([...IDLE_EVENTS]);
  });
});

describe('permission errors (EACCES / EPERM)', () => {
  // chmod-based simulation only works as non-root. CI runners (and Docker
  // images) sometimes run as root, in which case a 0o000 file is still
  // readable. Skip rather than emit a false pass.
  const runAsNonRoot =
    typeof process.getuid === 'function' && process.getuid() !== 0
      ? test
      : test.skip;

  runAsNonRoot(
    'unreadable settings.json → ok:false reason=permission_denied',
    async () => {
      const p = settingsPath();
      writeFileSync(p, JSON.stringify({ hooks: {} }));
      chmodSync(p, 0o000);
      try {
        const r = await install();
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.reason).toBe('permission_denied');
          expect(r.detail).toBeTruthy();
        }
      } finally {
        chmodSync(p, 0o644);
      }
    },
  );

  runAsNonRoot(
    'unwritable parent dir (backup fails) → permission_denied',
    async () => {
      writeFileSync(settingsPath(), JSON.stringify({ hooks: {} }));
      chmodSync(tmp, 0o500); // read + execute, no write
      try {
        const r = await install();
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('permission_denied');
      } finally {
        chmodSync(tmp, 0o755);
      }
    },
  );

  runAsNonRoot(
    'unwritable parent dir on a fresh install → permission_denied (write path)',
    async () => {
      // No existing settings.json; backup is skipped; atomicWriteJson is
      // the first thing to hit EACCES.
      chmodSync(tmp, 0o500);
      try {
        const r = await install();
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('permission_denied');
      } finally {
        chmodSync(tmp, 0o755);
      }
    },
  );

  runAsNonRoot(
    'uninstall on unreadable settings → permission_denied (not malformed)',
    async () => {
      const p = settingsPath();
      writeFileSync(p, JSON.stringify({ hooks: {} }));
      chmodSync(p, 0o000);
      try {
        const r = await uninstall();
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('permission_denied');
      } finally {
        chmodSync(p, 0o644);
      }
    },
  );
});

describe('concurrent writers (settings-file lock)', () => {
  test('two concurrent installs preserve user hooks and converge to idempotent state', async () => {
    const original = {
      apiKeyHelper: '/usr/local/bin/my-helper',
      hooks: {
        UserPromptSubmit: [
          {
            matcher: '',
            hooks: [{ type: 'command', command: 'user-prompt.sh' }],
          },
        ],
      },
    };
    writeFileSync(settingsPath(), JSON.stringify(original, null, 2));

    const [r1, r2] = await Promise.all([install(), install()]);
    expect(r1.ok && r2.ok).toBe(true);

    const after = readJson<typeof original>(settingsPath());
    // User key and hook survive both races.
    expect(after.apiKeyHelper).toBe(original.apiKeyHelper);
    expect(after.hooks.UserPromptSubmit).toEqual(
      original.hooks.UserPromptSubmit,
    );
    // Each Idle event has exactly one matcher-"" hook (idempotent).
    const settings = readJson<{
      hooks: Record<
        string,
        Array<{ matcher: string; hooks: Array<{ command: string }> }>
      >;
    }>(settingsPath());
    for (const hook of IDLE_HOOK_EVENTS) {
      const group = settings.hooks[hook.event]!.find(
        (g) => g.matcher === '',
      )!;
      const idleHooks = group.hooks.filter((h) =>
        isIdleOwnedCommand(h.command),
      );
      expect(idleHooks, `event=${hook.event}`).toHaveLength(1);
    }
  });

  test('concurrent install + uninstall produces a consistent final state', async () => {
    const original = {
      hooks: {
        UserPromptSubmit: [
          {
            matcher: '',
            hooks: [{ type: 'command', command: 'user-prompt.sh' }],
          },
        ],
      },
    };
    writeFileSync(settingsPath(), JSON.stringify(original, null, 2));

    // Install first so uninstall has something to remove.
    await install();

    const [r1, r2] = await Promise.all([install(), uninstall()]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    // The file is a valid JSON object and the user hook survives.
    const after = readJson<typeof original>(settingsPath());
    expect(after.hooks.UserPromptSubmit).toEqual(
      original.hooks.UserPromptSubmit,
    );
  });
});

describe('async flag per event', () => {
  test('SessionStart / PostToolUse / SessionEnd emit async: true; Stop stays synchronous', async () => {
    await install();
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
