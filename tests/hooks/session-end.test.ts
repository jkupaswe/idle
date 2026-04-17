import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { run } from '../../src/hooks/session-end.js';
import { readState, registerSession } from '../../src/core/state.js';
import type { SessionEntry, SessionId } from '../../src/lib/types.js';
import { isSessionId } from '../../src/lib/types.js';

let home: string;
const FIX = join(__dirname, '..', 'fixtures');

function asSessionId(raw: string): SessionId {
  if (!isSessionId(raw)) throw new Error(`invalid test session_id: ${raw}`);
  return raw;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'idle-sessionend-'));
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

async function seedSession(
  id: string,
  overrides: Partial<SessionEntry> = {},
): Promise<SessionEntry> {
  const entry: SessionEntry = {
    started_at: '2026-04-17T12:00:00.000Z',
    project_path: '/Users/dev/projects/example',
    tool_calls_since_checkin: 3,
    total_tool_calls: 42,
    last_checkin_at: '2026-04-17T12:30:00.000Z',
    checkins: ['2026-04-17T12:30:00.000Z'],
    ...overrides,
  };
  const result = await registerSession(asSessionId(id), entry);
  if (!result.ok) throw new Error(`seed failed: ${result.reason}`);
  return entry;
}

describe('session-end hook', () => {
  test('archives snapshot and removes live entry', async () => {
    const entry = await seedSession('sess_abc123');
    const code = await run(fixture('session-end-valid.json'));
    expect(code).toBe(0);

    // Live state has no entry for this session anymore.
    expect(readState().state.sessions['sess_abc123']).toBeUndefined();

    // Archive file exists and matches the pre-end snapshot.
    const archivePath = join(home, 'sessions', 'sess_abc123.json');
    expect(existsSync(archivePath)).toBe(true);
    const archived = JSON.parse(readFileSync(archivePath, 'utf8')) as SessionEntry;
    expect(archived).toEqual(entry);
  });

  test('unknown session_id logs debug and does nothing', async () => {
    const code = await run(fixture('session-end-unknown.json'));
    expect(code).toBe(0);

    const archivePath = join(home, 'sessions', 'sess_nope.json');
    expect(existsSync(archivePath)).toBe(false);
    expect(readDebugLog()).toMatch(
      /"msg":"session-end: no live session to end".*"reason":"not_found"/,
    );
  });

  test('exits 0 on invalid JSON', async () => {
    const code = await run('{ not json');
    expect(code).toBe(0);
    expect(readDebugLog()).toMatch(
      /"msg":"session-end: stdin is not valid JSON"/,
    );
  });

  test('exits 0 when session_id is missing or invalid', async () => {
    const code = await run(JSON.stringify({ reason: 'other' }));
    expect(code).toBe(0);
    expect(readDebugLog()).toMatch(/"msg":"session-end: invalid session_id"/);
  });

  test('rejects path-separator session_id without writing archive', async () => {
    const code = await run(
      JSON.stringify({
        session_id: '../evil',
        hook_event_name: 'SessionEnd',
      }),
    );
    expect(code).toBe(0);
    expect(existsSync(join(home, 'sessions'))).toBe(false);
    expect(readDebugLog()).toMatch(/"msg":"session-end: invalid session_id"/);
  });

  test('does not write to stdout', async () => {
    await seedSession('sess_abc123');
    const original = process.stdout.write;
    const chunks: string[] = [];
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await run(fixture('session-end-valid.json'));
    } finally {
      process.stdout.write = original;
    }
    expect(chunks.join('')).toBe('');
  });

  test('archive is JSON pretty-printed with trailing newline', async () => {
    await seedSession('sess_abc123');
    await run(fixture('session-end-valid.json'));
    const raw = readFileSync(
      join(home, 'sessions', 'sess_abc123.json'),
      'utf8',
    );
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toMatch(/\n  "started_at":/);
  });

  test('archive persists even after live state is re-reused', async () => {
    // Session A ends and is archived.
    await seedSession('sess_archive_a');
    const payload = JSON.stringify({
      session_id: 'sess_archive_a',
      hook_event_name: 'SessionEnd',
    });
    await run(payload);

    // Another session starts using a different id. Archive must stay.
    await seedSession('sess_archive_b');
    const archivePath = join(home, 'sessions', 'sess_archive_a.json');
    expect(existsSync(archivePath)).toBe(true);
  });
});
