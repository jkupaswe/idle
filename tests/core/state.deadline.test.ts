/**
 * Wall-clock deadline enforcement (Decision G).
 *
 * Dedicated file because vi.mock('node:fs') replaces the fs module for
 * every test in the file. The other state tests need the real fs.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Hoisted toggle so the vi.mock factory below (which runs before top-level
// awaits) can read a delay value that individual tests set.
const WRITE_DELAY = vi.hoisted(() => ({ ms: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    writeSync: function (...args: any[]) {
      if (WRITE_DELAY.ms > 0) {
        const end = Date.now() + WRITE_DELAY.ms;
        // Synchronous busy-wait simulates a stalled filesystem within a
        // sync writeSync call; the point is to eat wall-clock budget.
        while (Date.now() < end) {
          /* spin */
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.writeSync as any)(...args);
    },
  };
});

const { incrementToolCounter, registerSession } = await import(
  '../../src/core/state.js'
);
const { isSessionId, ms } = await import('../../src/lib/types.js');
import type { SessionId, ThresholdsConfig } from '../../src/lib/types.js';

function narrow(raw: string): SessionId {
  if (!isSessionId(raw)) throw new Error(`bad id: ${raw}`);
  return raw;
}

const SESSION = narrow('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
const DISABLED_THRESHOLDS: Readonly<ThresholdsConfig> = {
  time_minutes: 0,
  tool_calls: 0,
};

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'idle-deadline-'));
  WRITE_DELAY.ms = 0;
});

afterEach(() => {
  WRITE_DELAY.ms = 0;
  rmSync(tmp, { recursive: true, force: true });
});

describe('wall-clock deadline', () => {
  test('incrementToolCounter returns timeout when fs.writeSync stalls past the 200ms budget', async () => {
    const path = join(tmp, 'state.json');

    // Seed a session while writeSync is un-delayed.
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

    // Now make every writeSync take 300ms. Default incrementToolCounter
    // budget is 200ms, so the deadline must trip.
    WRITE_DELAY.ms = 300;

    const t0 = Date.now();
    const r = await incrementToolCounter(
      SESSION,
      { name: 'Tool', summary: 'x' },
      DISABLED_THRESHOLDS,
      { path },
    );
    const elapsed = Date.now() - t0;

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('timeout');
    // Sanity: we bailed in under a second (not stuck retrying forever).
    expect(elapsed).toBeLessThan(1_000);
  });

  test('succeeds when the explicit budget is larger than the simulated stall', async () => {
    const path = join(tmp, 'state.json');
    await registerSession(
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

    WRITE_DELAY.ms = 100; // under the override
    const r = await incrementToolCounter(
      SESSION,
      { name: 'Tool', summary: '' },
      DISABLED_THRESHOLDS,
      { path, timeoutMs: ms(2_000) },
    );
    expect(r.ok).toBe(true);
  });
});
