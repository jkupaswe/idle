import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { runStatus } from '../../src/commands/status.js';
import type { SessionEntry } from '../../src/lib/types.js';

import { useCliSandbox } from './_harness.js';

const ctx = useCliSandbox('status');

const TEST_CWD = '/Users/tester/projects/foo';

function writeConfig(body: string): void {
  mkdirSync(ctx.sandboxIdle, { recursive: true });
  writeFileSync(join(ctx.sandboxIdle, 'config.toml'), body);
}

function writeState(sessions: Record<string, SessionEntry>): void {
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
    started_at: minutesAgo(12),
    project_path: TEST_CWD,
    tool_calls_since_checkin: 4,
    total_tool_calls: 9,
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

describe('runStatus', () => {
  test('no config, no sessions → defaults, enabled', () => {
    const code = runStatus();
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toContain('active sessions: 0\n');
    expect(ctx.captured.stdout).toContain('pending check-ins: 0\n');
    expect(ctx.captured.stdout).toContain(
      `idle is: enabled for ${TEST_CWD}\n`,
    );
    expect(ctx.captured.stdout).toContain(
      'current thresholds: 45m / 40 tool calls\n',
    );
    expect(ctx.captured.stderr).toBe('');
  });

  test('active session with pending check-in counts correctly', () => {
    writeState({
      sess_active1: entry({
        started_at: minutesAgo(22),
        tool_calls_since_checkin: 15,
        pending_checkin: true,
      }),
      sess_active2: entry({ started_at: minutesAgo(3) }),
    });

    const code = runStatus();
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toContain('active sessions: 2\n');
    expect(ctx.captured.stdout).toContain('pending check-ins: 1\n');
    expect(ctx.captured.stdout).toMatch(
      /sess_act\s+started 22m ago\s+15 tools since checkin/,
    );
  });

  test('project disabled in config', () => {
    writeConfig(
      [
        '[projects]',
        `"${TEST_CWD}" = { enabled = false }`,
        '',
      ].join('\n'),
    );

    const code = runStatus();
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toContain(
      `idle is: disabled for ${TEST_CWD}\n`,
    );
  });

  test('project explicitly enabled in config', () => {
    writeConfig(
      [
        '[projects]',
        `"${TEST_CWD}" = { enabled = true }`,
        '',
      ].join('\n'),
    );

    const code = runStatus();
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toContain(
      `idle is: enabled for ${TEST_CWD}\n`,
    );
  });

  test('custom thresholds from config', () => {
    writeConfig(
      [
        '[thresholds]',
        'time_minutes = 60',
        'tool_calls = 100',
        '',
      ].join('\n'),
    );

    const code = runStatus();
    expect(code).toBe(0);
    expect(ctx.captured.stdout).toContain(
      'current thresholds: 60m / 100 tool calls\n',
    );
  });
});
