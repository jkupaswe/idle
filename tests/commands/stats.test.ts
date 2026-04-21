import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { runStats } from '../../src/commands/stats.js';
import type { SessionEntry } from '../../src/lib/types.js';

import { useCliSandbox } from './_harness.js';

const ctx = useCliSandbox('stats');

const TEST_CWD = '/Users/tester/projects/foo';
const OTHER_CWD = '/Users/tester/projects/bar';

function writeState(sessions: Record<string, unknown>): void {
  mkdirSync(ctx.sandboxIdle, { recursive: true });
  writeFileSync(
    join(ctx.sandboxIdle, 'state.json'),
    JSON.stringify({ sessions }),
  );
}

function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString();
}

function entry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    started_at: minutesAgo(30),
    project_path: TEST_CWD,
    tool_calls_since_checkin: 3,
    total_tool_calls: 7,
    last_checkin_at: null,
    checkins: [],
    ...overrides,
  };
}

let cwdSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(TEST_CWD);
});

afterEach(() => {
  cwdSpy?.mockRestore();
  cwdSpy = null;
});

describe('runStats (project)', () => {
  test('empty state → "No session data yet." exit 1', () => {
    const code = runStats({});
    expect(code).toBe(1);
    expect(ctx.captured.stdout).toBe('No session data yet.\n');
    expect(ctx.captured.stderr).toBe('');
  });

  test('state with sessions for other cwd → "No session data yet." exit 1', () => {
    writeState({
      sess_other: entry({ project_path: OTHER_CWD }),
    });

    const code = runStats({});
    expect(code).toBe(1);
    expect(ctx.captured.stdout).toBe('No session data yet.\n');
  });

  test('single session → aggregated project stats', () => {
    writeState({
      sess_abc12345: entry({
        started_at: minutesAgo(45),
        total_tool_calls: 32,
        checkins: [minutesAgo(20)],
      }),
    });

    const code = runStats({});
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toContain('sessions: 1\n');
    expect(ctx.captured.stdout).toContain('total tool calls: 32\n');
    expect(ctx.captured.stdout).toContain('total check-ins: 1\n');
    expect(ctx.captured.stdout).toMatch(/total session time: 45m\n/);
  });

  test('multiple sessions → aggregated totals', () => {
    writeState({
      sess_a1b2c3d4: entry({
        started_at: minutesAgo(30),
        total_tool_calls: 10,
        checkins: [minutesAgo(10), minutesAgo(5)],
      }),
      sess_e5f6a7b8: entry({
        started_at: minutesAgo(90),
        total_tool_calls: 22,
        checkins: [minutesAgo(40)],
      }),
      sess_other_cwd: entry({
        project_path: OTHER_CWD,
        total_tool_calls: 999,
      }),
    });

    const code = runStats({});
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toContain('sessions: 2\n');
    expect(ctx.captured.stdout).toContain('total tool calls: 32\n');
    expect(ctx.captured.stdout).toContain('total check-ins: 3\n');
    // 30m + 90m = 120m = 2h0m
    expect(ctx.captured.stdout).toMatch(/total session time: 2h0m\n/);
  });
});

describe('runStats (session)', () => {
  test('known session → line format', () => {
    writeState({
      sess_abc12345: entry({
        started_at: minutesAgo(47),
        total_tool_calls: 32,
        checkins: [minutesAgo(20)],
      }),
    });

    const code = runStats({ sessionId: 'sess_abc12345' });
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toMatch(
      /^sess_abc  \d{2}-\d{2} \d{2}:\d{2}  47m  32 tools  1 check-ins\n$/,
    );
  });

  test('invalid session id (contains slash) → exit 1', () => {
    const code = runStats({ sessionId: 'bad/id' });
    expect(code).toBe(1);
    expect(ctx.captured.stderr).toContain('Invalid session id: bad/id');
    expect(ctx.captured.stdout).toBe('');
  });

  test('unknown session id → exit 1 with "No such session"', () => {
    writeState({
      sess_present: entry(),
    });

    const code = runStats({ sessionId: 'sess_missing' });
    expect(code).toBe(1);
    expect(ctx.captured.stderr).toBe('No such session: sess_missing\n');
  });
});

describe('runStats (ReadStateResult variants)', () => {
  test('recovered: corrupt JSON → note + empty-data exit 1', () => {
    mkdirSync(ctx.sandboxIdle, { recursive: true });
    writeFileSync(join(ctx.sandboxIdle, 'state.json'), 'not json at all');

    const code = runStats({});
    expect(code).toBe(1);
    expect(ctx.captured.stdout).toMatch(
      /^Note: corrupt state file backed up to .*state\.json\.corrupt-.*\.\nNo session data yet\.\n$/,
    );

    // Sidecar file exists.
    const files = readdirSync(ctx.sandboxIdle);
    expect(files.some((f) => f.startsWith('state.json.corrupt-'))).toBe(true);
  });

  test('partial: one malformed entry → note + valid data', () => {
    writeState({
      sess_valid1: entry({ total_tool_calls: 5 }),
      sess_bad: { not_a_valid_entry: true },
    });

    const code = runStats({});
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toMatch(
      /^Note: 1 malformed session entries were backed up to .*\.corrupt-.*-entries\.\n/,
    );
    expect(ctx.captured.stdout).toContain('sessions: 1\n');
    expect(ctx.captured.stdout).toContain('total tool calls: 5\n');

    // Dropped-entries sidecar exists.
    const files = readdirSync(ctx.sandboxIdle);
    expect(files.some((f) => f.endsWith('-entries'))).toBe(true);
  });
});
