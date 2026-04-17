/**
 * Atomic read/write for `~/.idle/state.json`.
 *
 * Multiple Claude Code hooks may fire concurrently (PostToolUse races Stop,
 * SessionEnd can race either). State mutations must be serialized across
 * processes and applied atomically to disk.
 *
 * Strategy:
 * - `proper-lockfile` guards the critical section (5s max wait).
 * - Writes go through a write-temp-then-rename path with fsync.
 * - Corrupted JSON is backed up to `state.json.corrupt-<suffix>` and the
 *   caller starts over with `{sessions: {}}`. A hook must never throw
 *   because it couldn't parse prior state — that would break the session.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

import lockfile from 'proper-lockfile';

import { log } from '../lib/log.js';
import { idleStatePath } from '../lib/paths.js';
import { timestampSuffix } from '../lib/time.js';
import type { SessionState } from '../lib/types.js';

/** Maximum time the caller waits to acquire the file lock, in milliseconds. */
export const LOCK_TIMEOUT_MS = 5_000;

/**
 * Read the current state from `~/.idle/state.json`.
 *
 * Returns `{sessions: {}}` if the file does not exist. If the file exists but
 * is unreadable or contains invalid JSON, the corrupt file is renamed to
 * `state.json.corrupt-<suffix>` and `{sessions: {}}` is returned — callers
 * should never see a read failure that poisons a Claude Code session.
 */
export function readState(path: string = idleStatePath()): SessionState {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (isNotFound(err)) {
      return emptyState();
    }
    log('warn', 'state: read failed, starting fresh', {
      path,
      error: errMessage(err),
    });
    return emptyState();
  }

  try {
    return normalizeState(JSON.parse(raw));
  } catch (err) {
    const corruptPath = `${path}.corrupt-${timestampSuffix()}`;
    try {
      renameSync(path, corruptPath);
    } catch (renameErr) {
      log('error', 'state: could not back up corrupt file', {
        path,
        corruptPath,
        error: errMessage(renameErr),
      });
    }
    log('warn', 'state: corrupt JSON, backed up and reset', {
      path,
      corruptPath,
      error: errMessage(err),
    });
    return emptyState();
  }
}

/**
 * Apply `mutator` to the current state under a file lock, then persist it
 * atomically. The mutator receives the current state and may mutate it in
 * place or return a replacement object.
 *
 * Implementation notes:
 * - Acquires `proper-lockfile` with a ~5s retry budget.
 * - Ensures the state file exists before locking (proper-lockfile requires
 *   a real path by default).
 * - Writes to `state.json.tmp-<pid>-<rand>`, fsyncs, renames over the target.
 * - Releases the lock in a finally block so a throwing mutator doesn't
 *   leave the file locked.
 */
export async function updateState(
  mutator: (state: SessionState) => SessionState | void,
  path: string = idleStatePath(),
): Promise<SessionState> {
  ensureStateFile(path);

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(path, {
      retries: {
        retries: 50,
        minTimeout: 100,
        maxTimeout: 100,
        factor: 1,
        randomize: false,
      },
      stale: 30_000,
    });
  } catch (err) {
    log('error', 'state: lock acquisition failed', {
      path,
      timeoutMs: LOCK_TIMEOUT_MS,
      error: errMessage(err),
    });
    throw new Error(
      `Idle: could not acquire state lock within ${LOCK_TIMEOUT_MS}ms (${path})`,
    );
  }

  try {
    const current = readState(path);
    const maybeNext = mutator(current);
    const next = maybeNext ?? current;
    atomicWriteFile(path, JSON.stringify(next, null, 2) + '\n');
    return next;
  } finally {
    try {
      await release();
    } catch (err) {
      log('warn', 'state: lock release failed', {
        path,
        error: errMessage(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function emptyState(): SessionState {
  return { sessions: {} };
}

function normalizeState(value: unknown): SessionState {
  if (
    typeof value === 'object' &&
    value !== null &&
    'sessions' in value &&
    typeof (value as { sessions: unknown }).sessions === 'object' &&
    (value as { sessions: unknown }).sessions !== null &&
    !Array.isArray((value as { sessions: unknown }).sessions)
  ) {
    return value as SessionState;
  }
  return emptyState();
}

function ensureStateFile(path: string): void {
  try {
    readFileSync(path);
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  mkdirSync(dirname(path), { recursive: true });
  // Use an atomic seed so another racing process doesn't see an empty file.
  atomicWriteFile(path, JSON.stringify(emptyState(), null, 2) + '\n');
}

function atomicWriteFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const fd = openSync(tmp, 'w', 0o644);
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'ENOENT'
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
