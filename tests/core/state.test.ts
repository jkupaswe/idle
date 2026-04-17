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

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { readState, updateState } from '../../src/core/state.js';

const execFileP = promisify(execFile);
const REPO_ROOT = resolve(new URL('../..', import.meta.url).pathname);
const WORKER_SCRIPT = resolve(
  REPO_ROOT,
  'tests/core/fixtures/state-worker.ts',
);

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

describe('readState', () => {
  test('returns empty state if the file is missing', () => {
    const p = statePath();
    expect(readState(p)).toEqual({ sessions: {} });
    expect(existsSync(p)).toBe(false);
  });

  test('reads a valid state file', () => {
    const p = statePath();
    const state = {
      sessions: {
        abc: {
          started_at: '2026-04-16T00:00:00.000Z',
          project_path: '/Users/j/p',
          tool_calls_since_checkin: 3,
          total_tool_calls: 10,
          last_checkin_at: null,
          checkins: [],
        },
      },
    };
    writeFileSync(p, JSON.stringify(state));
    expect(readState(p)).toEqual(state);
  });

  test('backs up and recovers from corrupt JSON', () => {
    const p = statePath();
    writeFileSync(p, '{not json');
    const recovered = readState(p);
    expect(recovered).toEqual({ sessions: {} });
    expect(existsSync(p)).toBe(false); // original moved aside
    const entries = readdirSync(tmp);
    const corrupt = entries.find((e) => e.startsWith('state.json.corrupt-'));
    expect(corrupt).toBeDefined();
  });

  test('normalizes malformed shape to empty state', () => {
    const p = statePath();
    writeFileSync(p, JSON.stringify({ sessions: null }));
    expect(readState(p)).toEqual({ sessions: {} });
  });
});

describe('updateState', () => {
  test('applies mutator and persists atomically', async () => {
    const p = statePath();
    await updateState((s) => {
      s.sessions['sess-1'] = {
        started_at: '2026-04-16T00:00:00.000Z',
        project_path: '/tmp/a',
        tool_calls_since_checkin: 0,
        total_tool_calls: 0,
        last_checkin_at: null,
        checkins: [],
      };
    }, p);

    const round = readState(p);
    expect(round.sessions['sess-1']?.project_path).toBe('/tmp/a');
  });

  test('accepts a mutator that returns a replacement', async () => {
    const p = statePath();
    await updateState(() => ({ sessions: { r: mkEntry() } }), p);
    expect(Object.keys(readState(p).sessions)).toEqual(['r']);
  });

  test('leaves no .tmp artifact or stale lock on success', async () => {
    const p = statePath();
    await updateState((s) => {
      s.sessions['x'] = mkEntry();
    }, p);
    const entries = readdirSync(tmp);
    expect(entries.find((e) => e.includes('.tmp-'))).toBeUndefined();
    expect(entries.find((e) => e.endsWith('.lock'))).toBeUndefined();
  });

  test('releases the lock even if the mutator throws', async () => {
    const p = statePath();
    await expect(
      updateState(() => {
        throw new Error('mutator boom');
      }, p),
    ).rejects.toThrow('mutator boom');

    // A second call must still succeed — proves the lock released.
    await updateState((s) => {
      s.sessions['after'] = mkEntry();
    }, p);
    expect(readState(p).sessions['after']).toBeDefined();
  });

  test('serializes concurrent in-process calls', async () => {
    const p = statePath();
    const N = 20;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        updateState((s) => {
          const key = 'ctr';
          const prev = s.sessions[key]?.total_tool_calls ?? 0;
          s.sessions[key] = {
            ...mkEntry(),
            total_tool_calls: prev + 1,
            last_tool_name: String(i),
          };
        }, p),
      ),
    );
    expect(readState(p).sessions['ctr']?.total_tool_calls).toBe(N);
  });

  test('serializes concurrent cross-process calls', async () => {
    const p = statePath();
    const N = 8;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        execFileP(
          'node',
          [
            '--import',
            'tsx',
            WORKER_SCRIPT,
            p,
            'ctr',
            String(i),
          ],
          { cwd: REPO_ROOT },
        ),
      ),
    );
    const final = readState(p);
    expect(final.sessions['ctr']?.total_tool_calls).toBe(N);
  }, 30_000);
});
// ---------------------------------------------------------------------------

function mkEntry() {
  return {
    started_at: '2026-04-16T00:00:00.000Z',
    project_path: '/tmp',
    tool_calls_since_checkin: 0,
    total_tool_calls: 0,
    last_checkin_at: null,
    checkins: [] as string[],
  };
}

