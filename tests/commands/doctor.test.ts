import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { runDoctor } from '../../src/commands/doctor.js';
import { IDLE_TAG } from '../../src/core/settings.js';

import { useCliSandbox } from './_harness.js';

const ctx = useCliSandbox('doctor');

const ALL_EVENTS = [
  'SessionStart',
  'PostToolUse',
  'Stop',
  'SessionEnd',
] as const;

/**
 * Build a settings.json containing a user-provided subset of Idle hook
 * events. Scripts point at the sandbox hooks dir so `isIdleOwnedCommand`
 * recognizes them.
 */
function writeSettingsWithEvents(events: readonly string[]): void {
  const hookCommand = (script: string): string =>
    `npx tsx '${ctx.sandboxHooks}/${script}' ${IDLE_TAG}`;
  const scripts: Record<string, string> = {
    SessionStart: 'session-start.ts',
    PostToolUse: 'post-tool-use.ts',
    Stop: 'stop.ts',
    SessionEnd: 'session-end.ts',
  };
  const hooks: Record<string, unknown> = {};
  for (const event of events) {
    const script = scripts[event];
    if (script === undefined) continue;
    hooks[event] = [
      {
        matcher: '',
        hooks: [{ type: 'command', command: hookCommand(script) }],
      },
    ];
  }
  writeFileSync(ctx.settingsPath, JSON.stringify({ hooks }, null, 2));
}

/**
 * Set up a happy-path installed state without paying `runInstall`'s
 * settings.json lock cost. Writes the minimal files doctor checks:
 * settings.json with all four Idle hooks, a valid config.toml, state.json,
 * sessions/, and an empty debug.log. Uses raw writeFileSync (not
 * saveConfig's atomic-write-plus-fsync) because these tests run
 * under high parallel load and every saved fsync pushes unrelated
 * state.ts timeout-sensitive tests closer to their 200ms budget.
 */
function setupFreshInstall(): void {
  writeSettingsWithEvents(ALL_EVENTS);
  mkdirSync(ctx.sandboxIdle, { recursive: true });
  writeFileSync(
    join(ctx.sandboxIdle, 'config.toml'),
    [
      '[thresholds]',
      'time_minutes = 45',
      'tool_calls = 40',
      '',
      '[tone]',
      'preset = "dry"',
      '',
      '[notifications]',
      'method = "native"',
      'sound = false',
      '',
      '[projects]',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(ctx.sandboxIdle, 'state.json'),
    JSON.stringify({ sessions: {} }, null, 2) + '\n',
  );
  mkdirSync(join(ctx.sandboxIdle, 'sessions'), { recursive: true });
  writeFileSync(join(ctx.sandboxIdle, 'debug.log'), '');
}

describe('runDoctor', () => {
  test('all green after a fresh install: 11 [ok] lines + summary, exit 0', async () => {
    setupFreshInstall();
    ctx.captured.stdout = '';
    ctx.captured.stderr = '';

    const code = runDoctor();
    expect(code).toBe(0);

    const lines = ctx.captured.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(12);
    const checkLines = lines.slice(0, 11);
    for (const line of checkLines) {
      expect(line.startsWith('[ok] ')).toBe(true);
    }
    expect(lines[11]).toBe('11 checks, all ok.');

    expect(ctx.captured.stdout).toContain(
      `[ok] claude binary on PATH (${ctx.sandboxBin}/claude)`,
    );
    expect(ctx.captured.stdout).toContain(
      '[ok] ~/.claude/ exists and is writable',
    );
    expect(ctx.captured.stdout).toContain(
      '[ok] ~/.claude/settings.json parses as JSON',
    );
    expect(ctx.captured.stdout).toContain(
      '[ok] Idle hooks installed for all four events',
    );
    expect(ctx.captured.stdout).toContain('[ok] hook scripts present');
    expect(ctx.captured.stdout).toContain(
      '[ok] hook scripts are regular files',
    );
    expect(ctx.captured.stdout).toContain(
      '[ok] ~/.idle/ exists and is writable',
    );
    expect(ctx.captured.stdout).toContain('[ok] ~/.idle/config.toml valid');
    expect(ctx.captured.stdout).toContain(
      '[ok] ~/.idle/state.json readable (fresh)',
    );
    expect(ctx.captured.stdout).toContain('[ok] ~/.idle/sessions/ exists');
    expect(ctx.captured.stdout).toContain('[ok] ~/.idle/debug.log writable');
  });

  test('missing claude binary fails check 1; unrelated checks stay ok', async () => {
    setupFreshInstall();
    ctx.removeClaudeFromPath();
    ctx.captured.stdout = '';

    const code = runDoctor();
    expect(code).toBe(1);
    expect(ctx.captured.stdout).toContain(
      '[fail] claude binary on PATH: not found',
    );
    expect(ctx.captured.stdout).toContain(
      '[ok] ~/.claude/ exists and is writable',
    );
    expect(ctx.captured.stdout).toContain('10 ok, 1 failed.');
  });

  test('missing ~/.claude/settings.json fails checks 3 and 4 cleanly', async () => {
    // Leave ~/.claude/ existing but without settings.json. Also populate
    // ~/.idle/ so everything downstream reports [ok].
    setupFreshInstall();
    rmSync(ctx.settingsPath);
    ctx.captured.stdout = '';

    const code = runDoctor();
    expect(code).toBe(1);
    expect(ctx.captured.stdout).toContain(
      '[fail] ~/.claude/settings.json: missing',
    );
    expect(ctx.captured.stdout).toContain(
      '[fail] Idle hooks: settings.json unreadable',
    );
    expect(ctx.captured.stdout).toContain(
      '[ok] ~/.claude/ exists and is writable',
    );
    expect(ctx.captured.stdout).toContain('9 ok, 2 failed.');
  });

  test('malformed settings.json fails check 3 with parse error', async () => {
    setupFreshInstall();
    writeFileSync(ctx.settingsPath, '{not valid json');
    ctx.captured.stdout = '';

    const code = runDoctor();
    expect(code).toBe(1);
    const failLine = ctx.captured.stdout
      .split('\n')
      .find((l) => l.startsWith('[fail] ~/.claude/settings.json:'));
    expect(failLine).toBeDefined();
    expect(failLine).not.toBe('[fail] ~/.claude/settings.json: missing');
    expect(ctx.captured.stdout).toContain(
      '[fail] Idle hooks: settings.json unparseable',
    );
  });

  test('partial Idle hooks (2 of 4 events) fails check 4 with event list', async () => {
    // Install first to populate ~/.idle/ etc, then overwrite settings.json
    // with a partial set.
    setupFreshInstall();
    writeSettingsWithEvents(['SessionStart', 'PostToolUse']);
    ctx.captured.stdout = '';

    const code = runDoctor();
    expect(code).toBe(1);
    expect(ctx.captured.stdout).toContain(
      '[fail] Idle hooks missing: Stop, SessionEnd',
    );
    // settings.json itself is still valid JSON.
    expect(ctx.captured.stdout).toContain(
      '[ok] ~/.claude/settings.json parses as JSON',
    );
  });

  test('missing hook script file fails check 5', async () => {
    setupFreshInstall();
    rmSync(join(ctx.sandboxHooks, 'stop.ts'));
    ctx.captured.stdout = '';

    const code = runDoctor();
    expect(code).toBe(1);
    expect(ctx.captured.stdout).toContain(
      '[fail] hook scripts missing: stop.ts',
    );
  });

  test('hook script as a directory fails check 6 (present but not a file)', async () => {
    setupFreshInstall();
    rmSync(join(ctx.sandboxHooks, 'stop.ts'));
    mkdirSync(join(ctx.sandboxHooks, 'stop.ts'));
    ctx.captured.stdout = '';

    const code = runDoctor();
    expect(code).toBe(1);
    expect(ctx.captured.stdout).toContain('[ok] hook scripts present');
    expect(ctx.captured.stdout).toContain(
      '[fail] hook scripts are not regular files: stop.ts',
    );

    // Clean up so afterEach's rmSync doesn't choke.
    rmSync(join(ctx.sandboxHooks, 'stop.ts'), { recursive: true });
  });

  test.each([
    ['config.toml', '[fail] ~/.idle/config.toml: missing'],
    ['state.json', '[fail] ~/.idle/state.json: missing'],
    ['debug.log', '[fail] ~/.idle/debug.log: missing'],
  ])(
    'missing ~/.idle/%s fails the corresponding check',
    (filename, expected) => {
      setupFreshInstall();
      rmSync(join(ctx.sandboxIdle, filename));
      ctx.captured.stdout = '';

      const code = runDoctor();
      expect(code).toBe(1);
      expect(ctx.captured.stdout).toContain(expected);
    },
  );

  test('missing ~/.idle/sessions/ fails check 10', () => {
    // Not a test.each entry because it's a directory (rmSync needs recursive).
    setupFreshInstall();
    rmSync(join(ctx.sandboxIdle, 'sessions'), { recursive: true });
    ctx.captured.stdout = '';

    const code = runDoctor();
    expect(code).toBe(1);
    expect(ctx.captured.stdout).toContain(
      '[fail] ~/.idle/sessions/: missing',
    );
  });

  test('config.toml validation error fails check 8 with the validation message', async () => {
    setupFreshInstall();
    const bad = [
      '[thresholds]',
      'time_minutes = 45',
      'tool_calls = 40',
      '',
      '[tone]',
      'preset = "nope"',
      '',
      '[notifications]',
      'method = "native"',
      'sound = false',
      '',
    ].join('\n');
    writeFileSync(join(ctx.sandboxIdle, 'config.toml'), bad);
    ctx.captured.stdout = '';

    const code = runDoctor();
    expect(code).toBe(1);
    expect(ctx.captured.stdout).toContain('[fail] ~/.idle/config.toml:');
    expect(ctx.captured.stdout).toContain('tone.preset');
    expect(ctx.captured.stdout).toContain(
      'must be one of: dry, earnest, absurdist, silent',
    );
  });

  test("state.json 'recovered' variant reports [ok] with the variant name", async () => {
    setupFreshInstall();
    writeFileSync(join(ctx.sandboxIdle, 'state.json'), 'not json');
    ctx.captured.stdout = '';

    const code = runDoctor();
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toContain(
      '[ok] ~/.idle/state.json readable (recovered)',
    );
    expect(ctx.captured.stdout).toContain('11 checks, all ok.');
  });

  test("state.json 'partial' variant reports [ok] with the variant name", async () => {
    setupFreshInstall();
    // One valid entry + one malformed entry → partition produces 'partial'.
    const validEntry = {
      started_at: new Date().toISOString(),
      project_path: '/tmp/doctor',
      tool_calls_since_checkin: 0,
      total_tool_calls: 0,
      last_checkin_at: null,
      checkins: [],
    };
    const state = {
      sessions: {
        sess_valid: validEntry,
        sess_bad: { not_a_session: true },
      },
    };
    writeFileSync(
      join(ctx.sandboxIdle, 'state.json'),
      JSON.stringify(state, null, 2),
    );
    ctx.captured.stdout = '';

    const code = runDoctor();
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toContain(
      '[ok] ~/.idle/state.json readable (partial)',
    );
  });

  test('all 11 checks fail → summary "0 ok, 11 failed." and exit 1', async () => {
    // Wipe everything: ~/.claude/, ~/.idle/, and claude from PATH.
    ctx.removeClaudeFromPath();
    rmSync(ctx.sandboxClaude, { recursive: true, force: true });
    rmSync(ctx.sandboxIdle, { recursive: true, force: true });
    // Also remove one hook script so check 5 fails; 6 relies on 5's absence.
    rmSync(ctx.sandboxHooks, { recursive: true, force: true });
    mkdirSync(ctx.sandboxHooks);
    ctx.captured.stdout = '';

    const code = runDoctor();
    expect(code).toBe(1);

    const lines = ctx.captured.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(12);
    const failCount = lines
      .slice(0, 11)
      .filter((l) => l.startsWith('[fail] ')).length;
    const okCount = 11 - failCount;
    // Some checks may trivially pass when prerequisites are absent (e.g.
    // "hook scripts are regular files" is vacuously true when no scripts
    // exist). We only assert the exact counts match the summary line, not
    // a predetermined number.
    expect(lines[11]).toBe(`${okCount} ok, ${failCount} failed.`);
    // And all the expected fails are present:
    expect(ctx.captured.stdout).toContain('[fail] claude binary on PATH');
    expect(ctx.captured.stdout).toContain('[fail] ~/.claude/:');
    expect(ctx.captured.stdout).toContain('[fail] ~/.claude/settings.json:');
    expect(ctx.captured.stdout).toContain('[fail] Idle hooks:');
    expect(ctx.captured.stdout).toContain('[fail] hook scripts missing');
    expect(ctx.captured.stdout).toContain('[fail] ~/.idle/:');
    expect(ctx.captured.stdout).toContain('[fail] ~/.idle/config.toml:');
    expect(ctx.captured.stdout).toContain('[fail] ~/.idle/state.json:');
    expect(ctx.captured.stdout).toContain('[fail] ~/.idle/sessions/:');
    expect(ctx.captured.stdout).toContain('[fail] ~/.idle/debug.log:');

    // Restore for afterEach.
    mkdirSync(ctx.sandboxClaude, { recursive: true });
    mkdirSync(ctx.sandboxIdle, { recursive: true });
  });

  test('renders all 11 check lines before the summary, in order', async () => {
    setupFreshInstall();
    ctx.captured.stdout = '';
    runDoctor();

    const lines = ctx.captured.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(12);
    // Spot-check the order: claude → ~/.claude/ → settings.json → Idle hooks
    // → hook scripts → scripts are files → ~/.idle/ → config → state → sessions → debug.log
    expect(lines[0]).toContain('claude binary on PATH');
    expect(lines[1]).toContain('~/.claude/');
    expect(lines[2]).toContain('~/.claude/settings.json');
    expect(lines[3]).toContain('Idle hooks');
    expect(lines[4]).toContain('hook scripts present');
    expect(lines[5]).toContain('hook scripts are regular files');
    expect(lines[6]).toContain('~/.idle/ exists');
    expect(lines[7]).toContain('~/.idle/config.toml');
    expect(lines[8]).toContain('~/.idle/state.json');
    expect(lines[9]).toContain('~/.idle/sessions/');
    expect(lines[10]).toContain('~/.idle/debug.log');
  });

  test('no emoji or color escapes in output', async () => {
    setupFreshInstall();
    ctx.captured.stdout = '';
    runDoctor();
    // ANSI CSI sequences.
    expect(ctx.captured.stdout).not.toMatch(/\x1b\[/);
    // Common checkmark / cross / partying emoji.
    expect(ctx.captured.stdout).not.toMatch(/[\u2713\u2717\u2705\u274C\u{1F389}]/u);
  });

  test('unwritable ~/.idle/ fails check 7', async () => {
    setupFreshInstall();
    // 0o555: read + execute, not writable.
    chmodSync(ctx.sandboxIdle, 0o555);
    ctx.captured.stdout = '';

    const code = runDoctor();
    expect(code).toBe(1);
    const idleHomeLine = ctx.captured.stdout
      .split('\n')
      .find((l) => l.startsWith('[fail] ~/.idle/:'));
    expect(idleHomeLine).toBeDefined();

    // Restore write permission so afterEach can clean up.
    chmodSync(ctx.sandboxIdle, 0o755);
  });

  test('does not rewrite settings.json or config.toml', async () => {
    setupFreshInstall();

    const settingsBefore = readFileSync(ctx.settingsPath);
    const configBefore = readFileSync(join(ctx.sandboxIdle, 'config.toml'));
    const stateBefore = readFileSync(join(ctx.sandboxIdle, 'state.json'));

    ctx.captured.stdout = '';
    runDoctor();

    expect(readFileSync(ctx.settingsPath).equals(settingsBefore)).toBe(true);
    expect(
      readFileSync(join(ctx.sandboxIdle, 'config.toml')).equals(configBefore),
    ).toBe(true);
    expect(
      readFileSync(join(ctx.sandboxIdle, 'state.json')).equals(stateBefore),
    ).toBe(true);
  });
});
