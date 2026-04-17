import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { run } from '../../src/hooks/session-start.js';
import { readState } from '../../src/core/state.js';
import { isSessionId } from '../../src/lib/types.js';
import { isAbsolutePath } from '../../src/core/config.js';

let home: string;
const FIX = join(__dirname, '..', 'fixtures');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'idle-sessionstart-'));
  process.env.IDLE_HOME = home;
});

afterEach(() => {
  delete process.env.IDLE_HOME;
  rmSync(home, { recursive: true, force: true });
});

function fixture(name: string): string {
  return readFileSync(join(FIX, name), 'utf8');
}

function readDebugLog(): string {
  const path = join(home, 'debug.log');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

describe('session-start hook', () => {
  test('valid payload registers a new session and exits 0', async () => {
    const code = await run(fixture('session-start-valid.json'));
    expect(code).toBe(0);

    const state = readState();
    expect(state.kind).toBe('fresh');
    const sessionId = 'sess_abc123';
    if (!isSessionId(sessionId)) throw new Error('test fixture id invalid');
    const entry = state.state.sessions[sessionId];
    expect(entry).toBeDefined();
    expect(entry!.project_path).toBe('/Users/dev/projects/example');
    expect(entry!.tool_calls_since_checkin).toBe(0);
    expect(entry!.total_tool_calls).toBe(0);
    expect(entry!.last_checkin_at).toBeNull();
    expect(entry!.checkins).toEqual([]);
    expect(entry!.disabled).toBeUndefined();
    expect(entry!.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('exits 0 on invalid JSON and writes a warn log', async () => {
    const code = await run('not json {');
    expect(code).toBe(0);
    const state = readState();
    expect(Object.keys(state.state.sessions)).toEqual([]);
    expect(readDebugLog()).toMatch(/"msg":"session-start: stdin is not valid JSON"/);
  });

  test('exits 0 when payload is a JSON array and logs', async () => {
    const code = await run(JSON.stringify(['nope']));
    expect(code).toBe(0);
    expect(readDebugLog()).toMatch(
      /"msg":"session-start: stdin is not a JSON object"/,
    );
  });

  test('rejects invalid session_id (empty string) and logs', async () => {
    const code = await run(fixture('session-start-empty-id.json'));
    expect(code).toBe(0);
    expect(readState().state.sessions).toEqual({});
    expect(readDebugLog()).toMatch(/"msg":"session-start: invalid session_id"/);
  });

  test('rejects missing cwd and logs', async () => {
    const code = await run(fixture('session-start-missing-cwd.json'));
    expect(code).toBe(0);
    expect(readState().state.sessions).toEqual({});
    expect(readDebugLog()).toMatch(/"msg":"session-start: invalid cwd"/);
  });

  test('rejects relative cwd and logs', async () => {
    const code = await run(fixture('session-start-relative-cwd.json'));
    expect(code).toBe(0);
    expect(readState().state.sessions).toEqual({});
    expect(readDebugLog()).toMatch(/"msg":"session-start: invalid cwd"/);
  });

  test('second call for same session_id is a no-op (already_exists)', async () => {
    await run(fixture('session-start-valid.json'));
    const stateAfterFirst = readState().state;
    const firstStart =
      stateAfterFirst.sessions['sess_abc123']?.started_at ?? '';
    expect(firstStart).not.toBe('');

    await new Promise((r) => setTimeout(r, 10));
    const code = await run(fixture('session-start-resume.json'));
    expect(code).toBe(0);

    const stateAfterSecond = readState().state;
    // started_at must not change on resume — idempotent behavior.
    expect(stateAfterSecond.sessions['sess_abc123']?.started_at).toBe(firstStart);
    expect(readDebugLog()).toMatch(
      /"msg":"session-start: session already registered"/,
    );
  });

  test('honors per-project disabled override', async () => {
    // Write a config that disables the test cwd.
    const cwd = '/Users/dev/projects/example';
    if (!isAbsolutePath(cwd)) throw new Error('test cwd invalid');
    const tomlBody = [
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
      '[projects."/Users/dev/projects/example"]',
      'enabled = false',
      '',
    ].join('\n');
    writeFileSync(join(home, 'config.toml'), tomlBody);

    const code = await run(fixture('session-start-valid.json'));
    expect(code).toBe(0);

    const entry = readState().state.sessions['sess_abc123'];
    expect(entry?.disabled).toBe(true);
  });

  test('tolerates broken config and still registers the session', async () => {
    writeFileSync(join(home, 'config.toml'), 'this is =n0t valid = toml =');
    const code = await run(fixture('session-start-valid.json'));
    expect(code).toBe(0);
    const entry = readState().state.sessions['sess_abc123'];
    expect(entry).toBeDefined();
    expect(entry?.disabled).toBeUndefined();
    expect(readDebugLog()).toMatch(
      /"msg":"session-start: config load failed/,
    );
  });

  test('does not write to stdout', async () => {
    const originalWrite = process.stdout.write;
    const chunks: string[] = [];
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await run(fixture('session-start-valid.json'));
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(chunks.join('')).toBe('');
  });
});
