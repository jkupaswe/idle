import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import lockfile from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  consumePendingCheckin,
  DEFAULT_LOCK_TIMEOUT,
  incrementToolCounter,
  readState,
  takeSessionSnapshot,
  updateState,
} from '../../src/core/state.js';
import type {
  SessionEntry,
  SessionId,
  ThresholdsConfig,
} from '../../src/lib/types.js';
import { isSessionId, ms } from '../../src/lib/types.js';

const execFileP = promisify(execFile);
const REPO_ROOT = resolve(new URL('../..', import.meta.url).pathname);
const WORKER_SCRIPT = resolve(
  REPO_ROOT,
  'tests/core/fixtures/state-worker.ts',
);

const SESSION_A = narrow('11111111-2222-3333-4444-555555555555');
const SESSION_B = narrow('22222222-3333-4444-5555-666666666666');

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'idle-state-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function statePath(): string {
  return join(tmp, 'state.json');
}

function narrow(raw: string): SessionId {
  if (!isSessionId(raw)) throw new Error(`bad fixture session id: ${raw}`);
  return raw;
}

function baseEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    started_at: new Date().toISOString(),
    project_path: '/Users/j/proj',
    tool_calls_since_checkin: 0,
    total_tool_calls: 0,
    last_checkin_at: null,
    checkins: [],
    ...overrides,
  };
}

const THRESHOLDS: Readonly<ThresholdsConfig> = {
  time_minutes: 45,
  tool_calls: 40,
};

// ---------------------------------------------------------------------------
// Branded types
// ---------------------------------------------------------------------------

describe('isSessionId', () => {
  test('accepts UUID-shaped strings', () => {
    expect(isSessionId(SESSION_A)).toBe(true);
    expect(isSessionId('sess_abc123')).toBe(true);
  });

  test('rejects empty, oversized, or filesystem-unsafe values', () => {
    expect(isSessionId('')).toBe(false);
    expect(isSessionId('has/slash')).toBe(false);
    expect(isSessionId('has\\back')).toBe(false);
    expect(isSessionId('has\nnewline')).toBe(false);
    expect(isSessionId('x'.repeat(257))).toBe(false);
    expect(isSessionId(42)).toBe(false);
    expect(isSessionId(null)).toBe(false);
  });
});

describe('ms() and Milliseconds brand', () => {
  test('mints non-negative durations', () => {
    expect(ms(0)).toBe(0);
    expect(ms(100)).toBe(100);
    expect(DEFAULT_LOCK_TIMEOUT).toBe(5_000);
  });

  test('rejects NaN, infinity, and negatives', () => {
    expect(() => ms(-1)).toThrow(RangeError);
    expect(() => ms(NaN)).toThrow(RangeError);
    expect(() => ms(Infinity)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// readState — discriminated union
// ---------------------------------------------------------------------------

describe('readState', () => {
  test('kind=empty when file is missing', () => {
    const r = readState(statePath());
    expect(r.kind).toBe('empty');
    expect(r.state).toEqual({ sessions: {} });
    expect(Object.isFrozen(r.state)).toBe(true);
    expect(Object.isFrozen(r.state.sessions)).toBe(true);
  });

  test('kind=fresh for a valid state file, with deep-frozen snapshot', () => {
    const p = statePath();
    writeFileSync(
      p,
      JSON.stringify({ sessions: { [SESSION_A]: baseEntry() } }),
    );
    const r = readState(p);
    expect(r.kind).toBe('fresh');
    const entry = r.state.sessions[SESSION_A];
    expect(entry).toBeDefined();
    if (!entry) throw new Error('unreachable');
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.checkins)).toBe(true);
  });

  test('kind=recovered for corrupt JSON; backup path surfaced', () => {
    const p = statePath();
    writeFileSync(p, '{not json');
    const r = readState(p);
    expect(r.kind).toBe('recovered');
    if (r.kind !== 'recovered') throw new Error('unreachable');
    expect(r.state).toEqual({ sessions: {} });
    expect(r.corruptBackupPath).toMatch(/state\.json\.corrupt-/);
    expect(existsSync(r.corruptBackupPath)).toBe(true);
    expect(existsSync(p)).toBe(false);
  });

  test('kind=recovered for JSON that does not match the state schema', () => {
    const p = statePath();
    writeFileSync(p, JSON.stringify({ sessions: null }));
    const r = readState(p);
    expect(r.kind).toBe('recovered');
  });

  test('read errors never throw — fallback to empty', () => {
    const r = readState(statePath());
    expect(['empty', 'fresh', 'recovered']).toContain(r.kind);
  });
});

// ---------------------------------------------------------------------------
// updateState — Mutator<T>, timeouts as ok:false, not throws
// ---------------------------------------------------------------------------

describe('updateState', () => {
  test('applies mutator and persists atomically; returns mutator value', async () => {
    const p = statePath();
    const result = await updateState(
      (s) => {
        s.sessions[SESSION_A] = baseEntry({ project_path: '/tmp/a' });
        return 'done' as const;
      },
      { path: p },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('done');

    const round = readState(p);
    expect(round.state.sessions[SESSION_A]?.project_path).toBe('/tmp/a');
  });

  test('leaves no .tmp artifact or stale lock on success', async () => {
    const p = statePath();
    await updateState(
      (s) => {
        s.sessions[SESSION_A] = baseEntry();
      },
      { path: p },
    );
    const entries = readdirSync(tmp);
    expect(entries.find((e) => e.includes('.tmp-'))).toBeUndefined();
    expect(entries.find((e) => e.endsWith('.lock'))).toBeUndefined();
  });

  test('releases the lock even if the mutator throws', async () => {
    const p = statePath();
    await expect(
      updateState(
        () => {
          throw new Error('mutator boom');
        },
        { path: p },
      ),
    ).rejects.toThrow('mutator boom');

    const follow = await updateState(
      (s) => {
        s.sessions[SESSION_B] = baseEntry();
      },
      { path: p },
    );
    expect(follow.ok).toBe(true);
    expect(readState(p).state.sessions[SESSION_B]).toBeDefined();
  });

  test('serializes concurrent in-process calls', async () => {
    const p = statePath();
    const N = 20;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        updateState(
          (s) => {
            const prev = s.sessions[SESSION_A]?.total_tool_calls ?? 0;
            s.sessions[SESSION_A] = baseEntry({
              total_tool_calls: prev + 1,
              last_tool_name: String(i),
            });
          },
          { path: p },
        ),
      ),
    );
    expect(readState(p).state.sessions[SESSION_A]?.total_tool_calls).toBe(N);
  });

  test('serializes concurrent cross-process calls', async () => {
    const p = statePath();
    const N = 8;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        execFileP(
          'node',
          ['--import', 'tsx', WORKER_SCRIPT, p, SESSION_A, String(i)],
          { cwd: REPO_ROOT },
        ),
      ),
    );
    expect(readState(p).state.sessions[SESSION_A]?.total_tool_calls).toBe(N);
  }, 30_000);

  test("returns ok:false reason=timeout when the lock can't be acquired", async () => {
    const p = statePath();
    // Seed the file so proper-lockfile can lock it externally.
    writeFileSync(p, JSON.stringify({ sessions: {} }));
    const release = await lockfile.lock(p, { retries: 0, stale: 30_000 });
    try {
      const hurried = await updateState(() => 'never', {
        path: p,
        timeoutMs: ms(200),
      });
      expect(hurried.ok).toBe(false);
      if (!hurried.ok) expect(hurried.reason).toBe('timeout');
    } finally {
      await release();
    }
  });
});

// ---------------------------------------------------------------------------
// takeSessionSnapshot — pure read, discriminated union
// ---------------------------------------------------------------------------

describe('takeSessionSnapshot', () => {
  test('returns ok:true + frozen snapshot for an existing session', async () => {
    const p = statePath();
    await updateState(
      (s) => {
        s.sessions[SESSION_A] = baseEntry({ project_path: '/here' });
      },
      { path: p },
    );
    const r = takeSessionSnapshot(SESSION_A, { path: p });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.snapshot.project_path).toBe('/here');
    expect(Object.isFrozen(r.snapshot)).toBe(true);
  });

  test('returns ok:false reason=not_found otherwise', () => {
    const r = takeSessionSnapshot(SESSION_A, { path: statePath() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// consumePendingCheckin
// ---------------------------------------------------------------------------

describe('consumePendingCheckin', () => {
  test('clears flag, resets counters, appends checkin; returns pre-reset snapshot', async () => {
    const p = statePath();
    await updateState(
      (s) => {
        s.sessions[SESSION_A] = baseEntry({
          pending_checkin: true,
          tool_calls_since_checkin: 7,
          total_tool_calls: 50,
        });
      },
      { path: p },
    );

    const r = await consumePendingCheckin(SESSION_A, { path: p });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.entry.tool_calls_since_checkin).toBe(7);
    expect(r.cleared).toBe(true);
    expect(Object.isFrozen(r.entry)).toBe(true);

    const after = readState(p).state.sessions[SESSION_A];
    expect(after?.pending_checkin).toBe(false);
    expect(after?.tool_calls_since_checkin).toBe(0);
    expect(after?.last_checkin_at).not.toBeNull();
    expect(after?.checkins).toHaveLength(1);
  });

  test('reason=not_found when session is absent', async () => {
    const r = await consumePendingCheckin(SESSION_A, { path: statePath() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_found');
  });

  test('reason=not_pending when no threshold has tripped', async () => {
    const p = statePath();
    await updateState(
      (s) => {
        s.sessions[SESSION_A] = baseEntry();
      },
      { path: p },
    );
    const r = await consumePendingCheckin(SESSION_A, { path: p });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_pending');
  });

  test('reason=disabled short-circuits even if pending', async () => {
    const p = statePath();
    await updateState(
      (s) => {
        s.sessions[SESSION_A] = baseEntry({
          disabled: true,
          pending_checkin: true,
        });
      },
      { path: p },
    );
    const r = await consumePendingCheckin(SESSION_A, { path: p });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('disabled');
  });
});

// ---------------------------------------------------------------------------
// incrementToolCounter
// ---------------------------------------------------------------------------

describe('incrementToolCounter', () => {
  test('bumps counters, records last tool, truncates summary to 200', async () => {
    const p = statePath();
    await updateState(
      (s) => {
        s.sessions[SESSION_A] = baseEntry();
      },
      { path: p },
    );
    const long = 'x'.repeat(300);
    const r = await incrementToolCounter(
      SESSION_A,
      { name: 'Bash', summary: long },
      THRESHOLDS,
      { path: p },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.thresholdTripped).toBe(false);

    const entry = readState(p).state.sessions[SESSION_A];
    expect(entry?.tool_calls_since_checkin).toBe(1);
    expect(entry?.total_tool_calls).toBe(1);
    expect(entry?.last_tool_name).toBe('Bash');
    expect(entry?.last_tool_summary?.length).toBe(200);
  });

  test('returns thresholdTripped=true and sets pending_checkin at the N-th call', async () => {
    const p = statePath();
    const LIMIT = 3;
    const small: ThresholdsConfig = { time_minutes: 0, tool_calls: LIMIT };
    await updateState(
      (s) => {
        s.sessions[SESSION_A] = baseEntry();
      },
      { path: p },
    );

    let tripped = false;
    for (let i = 0; i < LIMIT; i++) {
      const r = await incrementToolCounter(
        SESSION_A,
        { name: 'Tool', summary: '' },
        small,
        { path: p },
      );
      if (r.ok && r.thresholdTripped) tripped = true;
    }
    expect(tripped).toBe(true);
    expect(readState(p).state.sessions[SESSION_A]?.pending_checkin).toBe(true);
  });

  test('time threshold trips when started_at is old enough', async () => {
    const p = statePath();
    const longAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    await updateState(
      (s) => {
        s.sessions[SESSION_A] = baseEntry({ started_at: longAgo });
      },
      { path: p },
    );
    const r = await incrementToolCounter(
      SESSION_A,
      { name: 'Read', summary: '' },
      { time_minutes: 45, tool_calls: 0 },
      { path: p },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.thresholdTripped).toBe(true);
  });

  test('thresholds set to 0 disable that check (PRD §6.2)', async () => {
    const p = statePath();
    await updateState(
      (s) => {
        s.sessions[SESSION_A] = baseEntry();
      },
      { path: p },
    );
    const r = await incrementToolCounter(
      SESSION_A,
      { name: 'Tool', summary: '' },
      { time_minutes: 0, tool_calls: 0 },
      { path: p },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.thresholdTripped).toBe(false);
  });

  test('reason=disabled short-circuits (no state mutation)', async () => {
    const p = statePath();
    await updateState(
      (s) => {
        s.sessions[SESSION_A] = baseEntry({
          disabled: true,
          total_tool_calls: 5,
        });
      },
      { path: p },
    );
    const r = await incrementToolCounter(
      SESSION_A,
      { name: 'Tool', summary: '' },
      THRESHOLDS,
      { path: p },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('disabled');
    expect(readState(p).state.sessions[SESSION_A]?.total_tool_calls).toBe(5);
  });

  test('reason=not_found for unknown session', async () => {
    const r = await incrementToolCounter(
      SESSION_A,
      { name: 'Tool', summary: '' },
      THRESHOLDS,
      { path: statePath() },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_found');
  });
});
