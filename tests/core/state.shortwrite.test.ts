/**
 * Short-write safety (Decision H).
 *
 * Writes to some filesystems (NFS, FUSE, certain container overlays) can
 * return a partial byte count. The internal `writeAllSync` loops until
 * every byte is written; this test forces a short first write and asserts
 * that the final file is complete, valid JSON.
 *
 * Dedicated file because `vi.mock('node:fs')` replaces the fs module for
 * every test in the file.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Hoisted toggle so the mock factory can see it. We count calls so exactly
// the N-th call returns a short write; other calls pass through.
const SHORT_WRITE = vi.hoisted(() => ({
  trigger: false,
  observedCalls: 0,
  shortWriteCount: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    writeSync: function (fd: number, ...rest: any[]) {
      SHORT_WRITE.observedCalls += 1;
      const buf = rest[0];
      if (SHORT_WRITE.trigger && buf instanceof Buffer && buf.length > 2) {
        // Write only the first half; return the partial byte count. The
        // real atomicWriteFile's writeAllSync must loop and complete the
        // remainder on a subsequent call.
        SHORT_WRITE.trigger = false;
        SHORT_WRITE.shortWriteCount += 1;
        const half = Math.floor(buf.length / 2);
        return actual.writeSync(fd, buf, 0, half);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.writeSync as any)(fd, ...rest);
    },
  };
});

const { incrementToolCounter, readState, registerSession } = await import(
  '../../src/core/state.js'
);
const { isSessionId, ms } = await import('../../src/lib/types.js');
import type { SessionId, ThresholdsConfig } from '../../src/lib/types.js';

function narrow(raw: string): SessionId {
  if (!isSessionId(raw)) throw new Error(`bad id: ${raw}`);
  return raw;
}

const SESSION = narrow('bbbbbbbb-cccc-dddd-eeee-ffffffffffff');
const DISABLED_THRESHOLDS: Readonly<ThresholdsConfig> = {
  time_minutes: 0,
  tool_calls: 0,
};

let tmp: string;
let idleHome: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'idle-shortwrite-'));
  SHORT_WRITE.trigger = false;
  SHORT_WRITE.observedCalls = 0;
  SHORT_WRITE.shortWriteCount = 0;
  // Sandbox log destination (F-015) in case any state-layer warning fires
  // while the short-write mock is armed.
  idleHome = mkdtempSync(join(tmpdir(), 'idle-shortwrite-home-'));
  process.env.IDLE_HOME = idleHome;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.IDLE_HOME;
  rmSync(idleHome, { recursive: true, force: true });
});

describe('short-write safety', () => {
  test('writeAllSync completes after a partial writeSync; final file is valid JSON', async () => {
    const path = join(tmp, 'state.json');

    // Seed a session while short-write is off.
    const reg = await registerSession(
      SESSION,
      {
        started_at: new Date().toISOString(),
        project_path: '/tmp',
        tool_calls_since_checkin: 0,
        total_tool_calls: 0,
        last_checkin_at: null,
        checkins: [],
      },
      { path, timeoutMs: ms(5_000) },
    );
    expect(reg.ok).toBe(true);

    // Arm the short-write for the next Buffer write. incrementToolCounter
    // will write a new state.json; its internal writeAllSync must loop.
    SHORT_WRITE.trigger = true;

    const r = await incrementToolCounter(
      SESSION,
      { name: 'Bash', summary: 'hello world' },
      DISABLED_THRESHOLDS,
      { path, timeoutMs: ms(5_000) },
    );
    expect(r.ok).toBe(true);

    // The mock fired at least one short write.
    expect(SHORT_WRITE.shortWriteCount).toBe(1);

    // The state file is complete and parseable — no truncation survived.
    const contents = readFileSync(path, 'utf8');
    const parsed = JSON.parse(contents) as {
      sessions: Record<string, { total_tool_calls: number; last_tool_name: string }>;
    };
    expect(parsed.sessions[SESSION]?.total_tool_calls).toBe(1);
    expect(parsed.sessions[SESSION]?.last_tool_name).toBe('Bash');

    // And readState agrees.
    const state = readState(path);
    expect(state.kind).toBe('fresh');
  });

});
