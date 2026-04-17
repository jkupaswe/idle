/**
 * Private implementation details for `src/core/state.ts`.
 *
 * Nothing in this file is part of the public Idle API. Hooks and CLI code
 * must go through the named helpers exported from `state.ts`; reaching in
 * here sidesteps the brand/timeout/threshold guarantees those helpers
 * enforce.
 *
 * Split out so a grep for `updateState` over `state.ts` returns nothing —
 * the module-private primitive is named `_updateState` here and is not
 * re-exported.
 */

import { Buffer } from 'node:buffer';
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
import { isValidSessionEntry, ms } from '../lib/types.js';
import type {
  Milliseconds,
  SessionEntry,
  SessionState,
} from '../lib/types.js';

// ---------------------------------------------------------------------------
// Internal plumbing. Nothing in this file is part of the public surface —
// `state.ts` owns the public constants and option shapes; this file owns
// `_updateState`, the mutator type, and the low-level fs helpers. Avoid
// exporting anything `state.ts` also exports or you re-create the dual-
// import-path ambiguity called out during review.
// ---------------------------------------------------------------------------

/** Internal default when the caller doesn't supply a timeout. Mirrored by
 *  `state.ts`'s exported `DEFAULT_LOCK_TIMEOUT` — kept in sync by eye. */
const INTERNAL_DEFAULT_LOCK_TIMEOUT: Milliseconds = ms(5_000);

// ---------------------------------------------------------------------------
// Deadline — wall-clock timeout enforcement across every phase of a state op.
// ---------------------------------------------------------------------------

/**
 * Wall-clock deadline. Computed from `Date.now() + budget` at the start of
 * an operation; checked between every subsequent phase (ensureStateFile,
 * lock acquisition, corruption recovery, read, mutate, write, fsync,
 * rename). If `isExpired(deadline)` at any boundary, the public helper
 * returns `{ ok: false, reason: 'timeout' }` after releasing any held
 * lock.
 *
 * Typed as a const-shaped interface rather than a bare number so nobody
 * accidentally passes a plain `Date.now() + N` around.
 */
export interface Deadline {
  readonly expiresAt: number;
}

export function makeDeadline(budget: Milliseconds): Deadline {
  return { expiresAt: Date.now() + budget };
}

export function isExpired(deadline: Deadline): boolean {
  return Date.now() >= deadline.expiresAt;
}

export function remainingMs(deadline: Deadline): Milliseconds {
  return ms(Math.max(0, deadline.expiresAt - Date.now()));
}

/**
 * Shape of the options argument `_updateState` accepts. Intentionally
 * INTERNAL — `state.ts` owns the public `UpdateStateOptions` type with
 * the same shape, and callers pass values of the public type. Structural
 * typing keeps them interchangeable without creating a second import
 * path for consumers.
 */
interface InternalStateOpOptions {
  readonly path?: string;
  readonly timeoutMs?: Milliseconds;
}

/** Mutator: given a mutable state, return the derived value. */
export type Mutator<T> = (state: SessionState) => T;

/** Outcome of `_updateState`. Timeouts never throw. */
export type UpdateStateResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: 'timeout' };

// ---------------------------------------------------------------------------
// _updateState — the sole mutation primitive. Module-private (not re-exported
// from state.ts). Named helpers compose it.
// ---------------------------------------------------------------------------

/**
 * Acquire the file lock, hand the mutator a mutable state, write the
 * result atomically, release. Mutator exceptions propagate; lock-timeouts
 * and any phase whose completion overshoots the deadline fold into
 * `{ ok: false, reason: 'timeout' }`.
 *
 * The deadline is a wall-clock ceiling, not just a lock budget. If a
 * filesystem call stalls (slow disk, seccomp pause, network filesystem),
 * we detect it at the next phase boundary and bail — even if the I/O
 * itself eventually returned.
 */
export async function _updateState<T>(
  mutator: Mutator<T>,
  options: InternalStateOpOptions = {},
): Promise<UpdateStateResult<T>> {
  const path = options.path ?? idleStatePath();
  const timeoutMs = options.timeoutMs ?? INTERNAL_DEFAULT_LOCK_TIMEOUT;
  const deadline = makeDeadline(timeoutMs);

  if (isExpired(deadline)) return TIMEOUT;

  ensureStateFile(path);
  if (isExpired(deadline)) return TIMEOUT;

  const release = await acquireLock(path, remainingMs(deadline));
  if (release === null) return TIMEOUT;

  try {
    if (isExpired(deadline)) return TIMEOUT;
    const current = readMutableState(path);
    if (isExpired(deadline)) return TIMEOUT;
    const value = mutator(current);
    if (isExpired(deadline)) return TIMEOUT;
    atomicWriteFile(path, JSON.stringify(current, null, 2) + '\n');
    if (isExpired(deadline)) return TIMEOUT;
    return { ok: true, value };
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

const TIMEOUT = { ok: false, reason: 'timeout' } as const;

// ---------------------------------------------------------------------------
// Read helpers shared by state.ts's readState and by _updateState
// ---------------------------------------------------------------------------

export function emptyState(): SessionState {
  return { sessions: {} };
}

/**
 * Weaker check than `isValidSessionEntry` — asserts the top-level shape
 * `{ sessions: object }`. Entries are validated separately.
 */
export function hasPlainSessionsMap(
  value: unknown,
): value is { sessions: Record<string, unknown> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  if (!('sessions' in value)) return false;
  const sessions = value.sessions;
  return (
    typeof sessions === 'object' &&
    sessions !== null &&
    !Array.isArray(sessions)
  );
}

export interface PartitionResult {
  readonly valid: Record<string, SessionEntry>;
  readonly dropped: {
    readonly count: number;
    readonly entries: Record<string, unknown>;
  };
}

/**
 * Walk every session id → raw value pair. Keep only those that pass
 * `isValidSessionEntry`; collect the rest for backup. Log each drop so
 * operators notice entries silently disappearing.
 */
export function partitionEntries(
  input: Record<string, unknown>,
): PartitionResult {
  const valid: Record<string, SessionEntry> = {};
  const dropped: Record<string, unknown> = {};
  let count = 0;
  for (const [id, raw] of Object.entries(input)) {
    if (isValidSessionEntry(raw)) {
      valid[id] = raw;
    } else {
      dropped[id] = raw;
      count += 1;
      log('warn', 'state: dropping malformed session entry', {
        session_id: id,
        reason: 'schema_mismatch',
      });
    }
  }
  return { valid, dropped: { count, entries: dropped } };
}

/**
 * Read state for mutation. Corrupt or missing files yield an empty state
 * (corrupt files are backed up first). Per-entry invalid sessions are
 * stripped and backed up to a `-entries` sidecar so the mutator operates
 * on a clean shape.
 */
function readMutableState(path: string): SessionState {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (!isNotFound(err)) {
      log('warn', 'state: read failed, starting fresh', {
        path,
        error: errMessage(err),
      });
    }
    return emptyState();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    backupCorruptFile(path, err);
    return emptyState();
  }

  if (!hasPlainSessionsMap(parsed)) {
    backupCorruptFile(path, new Error('state schema mismatch'));
    return emptyState();
  }

  const { valid, dropped } = partitionEntries(parsed.sessions);
  if (dropped.count > 0) {
    backupDroppedEntries(path, dropped.entries);
  }
  return { sessions: valid };
}

// ---------------------------------------------------------------------------
// Lock + filesystem primitives
// ---------------------------------------------------------------------------

/** Lock acquisition wrapped so timeouts become a nullable return. */
async function acquireLock(
  path: string,
  timeoutMs: Milliseconds,
): Promise<(() => Promise<void>) | null> {
  const retries = Math.max(1, Math.floor(timeoutMs / 100));
  try {
    return await lockfile.lock(path, {
      retries: {
        retries,
        minTimeout: 100,
        maxTimeout: 100,
        factor: 1,
        randomize: false,
      },
      stale: 30_000,
    });
  } catch (err) {
    log('warn', 'state: lock acquisition timed out', {
      path,
      timeoutMs,
      error: errMessage(err),
    });
    return null;
  }
}

/**
 * Create an empty state file iff it does not already exist, atomically.
 * `openSync(path, 'wx')` + EEXIST tolerance so two racing workers can't
 * stomp each other's writes.
 */
function ensureStateFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o644);
  } catch (err) {
    if (isAlreadyExists(err)) return;
    throw err;
  }
  try {
    writeAllSync(
      fd,
      Buffer.from(JSON.stringify(emptyState(), null, 2) + '\n', 'utf8'),
    );
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Loop-until-done wrapper around `writeSync`. `writeSync` can return a
 * partial byte count on some filesystems (NFS, FUSE, certain container
 * overlays); the previous one-shot call could silently leave truncated
 * JSON on disk. `writeAllSync` calls `writeSync(fd, buffer, offset,
 * remaining)` repeatedly until the whole buffer is written, and throws
 * if `writeSync` ever returns `<= 0`.
 *
 * Typed buffer only — callers convert strings via `Buffer.from(s, 'utf8')`
 * so the encoding is explicit.
 */
function writeAllSync(fd: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.length) {
    const remaining = buffer.length - offset;
    const written = writeSync(fd, buffer, offset, remaining);
    if (written <= 0) {
      throw new Error(
        `writeAllSync: writeSync returned ${written} with ${remaining} bytes remaining`,
      );
    }
    offset += written;
  }
}

function atomicWriteFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const fd = openSync(tmp, 'w', 0o644);
  try {
    writeAllSync(fd, Buffer.from(contents, 'utf8'));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function backupCorruptFile(path: string, cause: unknown): string {
  const backupPath = `${path}.corrupt-${timestampSuffix()}`;
  try {
    renameSync(path, backupPath);
  } catch (err) {
    log('error', 'state: could not back up corrupt file', {
      path,
      backupPath,
      error: errMessage(err),
    });
  }
  log('warn', 'state: corrupt JSON, backed up and reset', {
    path,
    backupPath,
    error: errMessage(cause),
  });
  return backupPath;
}

export function backupDroppedEntries(
  statePath: string,
  dropped: Record<string, unknown>,
): string {
  const backupPath = `${statePath}.corrupt-${timestampSuffix()}-entries`;
  try {
    atomicWriteFile(backupPath, JSON.stringify(dropped, null, 2) + '\n');
  } catch (err) {
    log('error', 'state: could not back up dropped entries', {
      backupPath,
      error: errMessage(err),
    });
  }
  return backupPath;
}

// ---------------------------------------------------------------------------
// Deep-freeze helpers for public snapshots
// ---------------------------------------------------------------------------

export function freezeEntry(entry: SessionEntry): Readonly<SessionEntry> {
  Object.freeze(entry.checkins);
  return Object.freeze(entry);
}

export function freezeState(state: SessionState): Readonly<SessionState> {
  for (const entry of Object.values(state.sessions)) {
    freezeEntry(entry);
  }
  Object.freeze(state.sessions);
  return Object.freeze(state);
}

// ---------------------------------------------------------------------------
// Small utilities used by helpers
// ---------------------------------------------------------------------------

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

export function minutesSinceCheckin(entry: SessionEntry): number {
  const anchor = entry.last_checkin_at ?? entry.started_at;
  const then = Date.parse(anchor);
  if (!Number.isFinite(then)) return 0;
  return Math.max(0, (Date.now() - then) / 60_000);
}

function isAlreadyExists(err: unknown): err is NodeJS.ErrnoException {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === 'EEXIST'
  );
}

function isNotFound(err: unknown): err is NodeJS.ErrnoException {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === 'ENOENT'
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
