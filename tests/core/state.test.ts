import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
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
  registerSession,
  removeSession,
  takeSessionSnapshot,
} from '../../src/core/state.js';
// _updateState is the module-private mutation primitive. Tests that need
// to exercise its behaviors (throwing mutators, concurrent serialization,
// lock timeouts) import from the internal module; production code cannot.
import { _updateState } from '../../src/core/state.internal.js';
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
let idleHome: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'idle-state-'));
  // Sandbox log destination so state warnings (dropping malformed entries,
  // corrupt JSON recovery, lock timeouts) don't pollute ~/.idle/debug.log.
  // F-015: log.ts routes through idleDebugLog() which honors IDLE_HOME.
  idleHome = mkdtempSync(join(tmpdir(), 'idle-state-home-'));
  process.env.IDLE_HOME = idleHome;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.IDLE_HOME;
  rmSync(idleHome, { recursive: true, force: true });
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
    expect(['empty', 'fresh', 'recovered', 'partial']).toContain(r.kind);
  });

  test('kind=partial — one good entry, one malformed; only the good one survives', () => {
    const p = statePath();
    const good = baseEntry({ project_path: '/valid' });
    const bad = { started_at: 'ok', project_path: 'ok' }; // missing required fields
    writeFileSync(
      p,
      JSON.stringify({
        sessions: {
          [SESSION_A]: good,
          [SESSION_B]: bad,
        },
      }),
    );

    const r = readState(p);
    expect(r.kind).toBe('partial');
    if (r.kind !== 'partial') throw new Error('unreachable');
    expect(r.droppedEntries).toBe(1);
    expect(r.state.sessions[SESSION_A]?.project_path).toBe('/valid');
    expect(r.state.sessions[SESSION_B]).toBeUndefined();
    expect(r.backupPath).toMatch(/state\.json\.corrupt-.*-entries$/);
    expect(existsSync(r.backupPath)).toBe(true);
    const backup = JSON.parse(
      readFileSync(r.backupPath, 'utf8'),
    ) as Record<string, unknown>;
    expect(backup[SESSION_B]).toEqual(bad);
  });
});

// ---------------------------------------------------------------------------
// _updateState — Mutator<T>, timeouts as ok:false, not throws
// ---------------------------------------------------------------------------

describe('_updateState (internal primitive)', () => {
  test('applies mutator and persists atomically; returns mutator value', async () => {
    const p = statePath();
    const result = await _updateState(
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
    await _updateState(
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
      _updateState(
        () => {
          throw new Error('mutator boom');
        },
        { path: p },
      ),
    ).rejects.toThrow('mutator boom');

    const follow = await _updateState(
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
        _updateState(
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

  test('serializes concurrent cross-process calls via the public incrementToolCounter', async () => {
    const p = statePath();
    const N = 8;
    // Parent registers the session; workers only increment (which is the
    // only state-mutation path the public API exposes).
    const reg = await registerSession(SESSION_A, baseEntry(), { path: p });
    expect(reg.ok).toBe(true);

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
      const hurried = await _updateState(() => 'never', {
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
    await _updateState(
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
// registerSession + removeSession
// ---------------------------------------------------------------------------

describe('registerSession', () => {
  test('inserts a new session and returns a frozen snapshot', async () => {
    const p = statePath();
    const r = await registerSession(
      SESSION_A,
      baseEntry({ project_path: '/here' }),
      { path: p },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.entry.project_path).toBe('/here');
    expect(Object.isFrozen(r.entry)).toBe(true);
    expect(readState(p).state.sessions[SESSION_A]).toBeDefined();
  });

  test('reason=already_exists when the session id is already present', async () => {
    const p = statePath();
    await registerSession(SESSION_A, baseEntry(), { path: p });
    const second = await registerSession(SESSION_A, baseEntry(), { path: p });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('already_exists');
  });

  test('copies caller-supplied arrays so later mutation does not leak in', async () => {
    const p = statePath();
    const mutableCheckins: string[] = ['2026-04-17T00:00:00.000Z'];
    const input = baseEntry({ checkins: mutableCheckins });
    await registerSession(SESSION_A, input, { path: p });
    mutableCheckins.push('2026-04-17T00:05:00.000Z');
    const stored = readState(p).state.sessions[SESSION_A];
    expect(stored?.checkins).toHaveLength(1);
  });
});

describe('removeSession', () => {
  test('removes an existing session and returns the frozen entry', async () => {
    const p = statePath();
    await registerSession(SESSION_A, baseEntry(), { path: p });
    const r = await removeSession(SESSION_A, { path: p });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.removed).not.toBeNull();
    if (r.removed) expect(Object.isFrozen(r.removed)).toBe(true);
    expect(readState(p).state.sessions[SESSION_A]).toBeUndefined();
  });

  test('idempotent: removing an absent session returns removed=null', async () => {
    const r = await removeSession(SESSION_A, { path: statePath() });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.removed).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// consumePendingCheckin
// ---------------------------------------------------------------------------

describe('consumePendingCheckin', () => {
  test('clears flag, resets counters, appends checkin; returns pre-reset snapshot', async () => {
    const p = statePath();
    await _updateState(
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
    await _updateState(
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
    await _updateState(
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

  test('malformed entry is silently dropped → reason=not_found', async () => {
    const p = statePath();
    writeFileSync(
      p,
      JSON.stringify({
        sessions: { [SESSION_A]: { started_at: 'only' } },
      }),
    );
    const r = await consumePendingCheckin(SESSION_A, { path: p });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_found');
    // The malformed entry is gone after the operation.
    const after = readState(p);
    expect(after.state.sessions[SESSION_A]).toBeUndefined();
  });

  test('10 concurrent consumes against one pending checkin → exactly one wins', async () => {
    const p = statePath();
    await registerSession(
      SESSION_A,
      baseEntry({ pending_checkin: true, tool_calls_since_checkin: 50 }),
      { path: p, timeoutMs: ms(10_000) },
    );

    const N = 10;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        consumePendingCheckin(SESSION_A, {
          path: p,
          timeoutMs: ms(10_000),
        }),
      ),
    );

    const wins = results.filter((r) => r.ok);
    const losses = results.filter(
      (r) => !r.ok && r.reason === 'not_pending',
    );
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(N - 1);

    // State is clean after the race: no pending flag, one checkin recorded,
    // counters reset.
    const entry = readState(p).state.sessions[SESSION_A];
    expect(entry?.pending_checkin).toBe(false);
    expect(entry?.checkins).toHaveLength(1);
    expect(entry?.tool_calls_since_checkin).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// incrementToolCounter
// ---------------------------------------------------------------------------

describe('incrementToolCounter', () => {
  test('bumps counters, records last tool, truncates summary to 200', async () => {
    const p = statePath();
    await _updateState(
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
    await _updateState(
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
    await _updateState(
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
    await _updateState(
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
    await _updateState(
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

  test('malformed entry is silently dropped → reason=not_found', async () => {
    const p = statePath();
    writeFileSync(
      p,
      JSON.stringify({
        sessions: { [SESSION_A]: { broken: true } },
      }),
    );
    const r = await incrementToolCounter(
      SESSION_A,
      { name: 'Tool', summary: '' },
      THRESHOLDS,
      { path: p },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_found');
    expect(readState(p).state.sessions[SESSION_A]).toBeUndefined();
  });

  // F-005: the Hook-layer sanitizer in src/hooks/tool-summary.ts is the
  // first line of defense, but any caller that hands a raw secret to
  // `incrementToolCounter` — a test harness, an internal CLI, a future
  // hook — must still not be able to persist it. These tests call
  // `incrementToolCounter` directly with unredacted input and assert
  // that what lands on disk has been scrubbed.
  describe('defense-in-depth: redacts secrets in name and summary', () => {
    test('redacts secret patterns in tool.summary before persistence', async () => {
      const p = statePath();
      await _updateState(
        (s) => {
          s.sessions[SESSION_A] = baseEntry();
        },
        { path: p },
      );
      const leaky =
        'OPENAI_API_KEY=sk-abcdef1234567890abcdef ghp_aaaaaaaaaaaaaaaaaaaaaaaaaa';
      const r = await incrementToolCounter(
        SESSION_A,
        { name: 'Bash', summary: leaky },
        THRESHOLDS,
        { path: p },
      );
      expect(r.ok).toBe(true);

      const entry = readState(p).state.sessions[SESSION_A];
      const summary = entry?.last_tool_summary ?? '';
      expect(summary).not.toContain('sk-abcdef1234567890abcdef');
      expect(summary).not.toContain('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(summary).toContain('<redacted>');

      const raw = readFileSync(p, 'utf8');
      expect(raw).not.toContain('sk-abcdef1234567890abcdef');
      expect(raw).not.toContain('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaa');
    });

    test('redacts secret patterns in tool.name before persistence', async () => {
      const p = statePath();
      await _updateState(
        (s) => {
          s.sessions[SESSION_A] = baseEntry();
        },
        { path: p },
      );
      const r = await incrementToolCounter(
        SESSION_A,
        { name: 'Bearer abcdef1234567890abcdef', summary: '' },
        THRESHOLDS,
        { path: p },
      );
      expect(r.ok).toBe(true);

      const entry = readState(p).state.sessions[SESSION_A];
      expect(entry?.last_tool_name).toBe('Bearer <redacted>');
    });

    test('redacts before truncating so a secret split at 200 chars is still scrubbed', async () => {
      const p = statePath();
      await _updateState(
        (s) => {
          s.sessions[SESSION_A] = baseEntry();
        },
        { path: p },
      );
      // Place the secret near the 200-char boundary so a naive
      // truncate-then-redact order would slice the pattern mid-token.
      const prefix = 'x'.repeat(190);
      const summary = `${prefix} sk-abcdef1234567890abcdef tail`;
      const r = await incrementToolCounter(
        SESSION_A,
        { name: 'Bash', summary },
        THRESHOLDS,
        { path: p },
      );
      expect(r.ok).toBe(true);

      const entry = readState(p).state.sessions[SESSION_A];
      expect(entry?.last_tool_summary).not.toContain('sk-abcdef');
      expect(entry?.last_tool_summary?.length).toBeLessThanOrEqual(200);
    });
  });
});
