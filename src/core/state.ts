/**
 * Atomic read/write for `~/.idle/state.json`, plus the named helpers hook
 * scripts call (`consumePendingCheckin`, `takeSessionSnapshot`,
 * `incrementToolCounter`).
 *
 * Typing posture (see CLAUDE.md + Core typing standards):
 * - `SessionId` and `Milliseconds` are branded; plain strings/numbers can't
 *   reach state helpers without going through `isSessionId` / `ms()`.
 * - `readState()` returns a discriminated union (`fresh | empty | recovered`)
 *   so corruption surfaces as an observable event rather than a thrown
 *   error. The recovered case still carries a usable `Readonly<SessionState>`.
 * - Mutators run against a mutable `SessionState` copy; callers of
 *   `readState()` and the named helpers get deep-frozen snapshots.
 * - Every failure mode is a `{ ok: false, reason }` branch — no nullable
 *   returns, no null-as-"not found", no strings sneaking out of Error.
 * - Lock-acquisition timeouts never throw; they land in the discriminated
 *   union so callers can decide whether to retry or degrade gracefully.
 *
 * Concurrency: `proper-lockfile` guards the critical section (~5s wait
 * budget). Writes go through write-temp-then-rename with fsync. Corrupt
 * JSON is backed up to `state.json.corrupt-<suffix>` and the caller
 * proceeds against an empty state — a hook must never break a session
 * because it couldn't parse prior state.
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
import { nowIso, timestampSuffix } from '../lib/time.js';
import { isValidSessionEntry, ms } from '../lib/types.js';
import type {
  Milliseconds,
  SessionEntry,
  SessionId,
  SessionState,
  ThresholdsConfig,
} from '../lib/types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Default lock-acquisition budget. See `updateState()` options. */
export const DEFAULT_LOCK_TIMEOUT: Milliseconds = ms(5_000);

/**
 * Outcome of `readState()`. Always carries a `Readonly<SessionState>` —
 * callers can continue regardless of which arm fires. The discriminator
 * tells them which recovery path fired:
 *
 * - `fresh` — file parsed cleanly, every entry valid.
 * - `empty` — file missing (not an error).
 * - `recovered` — top-level JSON/schema failure; whole file backed up,
 *   callers get an empty state.
 * - `partial` — file parsed, but one or more entries failed
 *   `isValidSessionEntry`. Dropped entries are written to a
 *   `state.json.corrupt-<suffix>-entries` sidecar; the state returned
 *   contains only the valid entries so helpers like
 *   `consumePendingCheckin` don't crash on `entry.checkins is not
 *   iterable`.
 */
export type ReadStateResult =
  | { readonly kind: 'fresh'; readonly state: Readonly<SessionState> }
  | { readonly kind: 'empty'; readonly state: Readonly<SessionState> }
  | {
      readonly kind: 'recovered';
      readonly state: Readonly<SessionState>;
      readonly corruptBackupPath: string;
    }
  | {
      readonly kind: 'partial';
      readonly state: Readonly<SessionState>;
      readonly droppedEntries: number;
      readonly backupPath: string;
    };

/** Options accepted by `updateState` and the named mutation helpers. */
export interface UpdateStateOptions {
  /** Override `~/.idle/state.json`. Used by tests. */
  readonly path?: string;
  /** Maximum wait for the file lock. Defaults to 5s. */
  readonly timeoutMs?: Milliseconds;
}

/**
 * The mutator receives a mutable `SessionState` copy so it can modify
 * entries in place, and returns whatever derived value the caller needs
 * (typically a typed outcome). The returned value flows out through the
 * `ok: true` arm of `UpdateStateResult`; writes happen atomically after
 * the mutator returns.
 */
export type Mutator<T> = (state: SessionState) => T;

/** Outcome of `updateState`. Timeouts never throw. */
export type UpdateStateResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: 'timeout' };

/** Outcome of `takeSessionSnapshot(id)`. */
export type SnapshotResult =
  | { readonly ok: true; readonly snapshot: Readonly<SessionEntry> }
  | { readonly ok: false; readonly reason: 'not_found' };

/** Outcome of `consumePendingCheckin(id)`. */
export type ConsumePendingResult =
  | {
      readonly ok: true;
      readonly entry: Readonly<SessionEntry>;
      readonly cleared: true;
    }
  | {
      readonly ok: false;
      readonly reason: 'not_found' | 'not_pending' | 'disabled' | 'timeout';
    };

/** Outcome of `incrementToolCounter(id, tool)`. */
export type IncrementToolResult =
  | { readonly ok: true; readonly thresholdTripped: boolean }
  | {
      readonly ok: false;
      readonly reason: 'not_found' | 'disabled' | 'timeout';
    };

/** The write-relevant slice of a PostToolUse payload. */
export interface ToolCall {
  readonly name: string;
  readonly summary: string;
}

// ---------------------------------------------------------------------------
// readState — discriminated union, no throws
// ---------------------------------------------------------------------------

/**
 * Read `~/.idle/state.json` and return a frozen snapshot. Missing file is
 * not an error (`kind: 'empty'`); corrupt JSON is backed up and the caller
 * gets an empty recovered state (`kind: 'recovered'`). Never throws — any
 * underlying I/O error is logged and maps to the empty arm.
 */
export function readState(path: string = idleStatePath()): ReadStateResult {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (isNotFound(err)) {
      return { kind: 'empty', state: freezeState(emptyState()) };
    }
    log('warn', 'state: read failed, treating as empty', {
      path,
      error: errMessage(err),
    });
    return { kind: 'empty', state: freezeState(emptyState()) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const backupPath = backupCorruptFile(path, err);
    return {
      kind: 'recovered',
      state: freezeState(emptyState()),
      corruptBackupPath: backupPath,
    };
  }

  if (!hasPlainSessionsMap(parsed)) {
    const backupPath = backupCorruptFile(path, new Error('state schema mismatch'));
    return {
      kind: 'recovered',
      state: freezeState(emptyState()),
      corruptBackupPath: backupPath,
    };
  }

  const { valid, dropped } = partitionEntries(parsed.sessions);
  if (dropped.count > 0) {
    const backupPath = backupDroppedEntries(path, dropped.entries);
    return {
      kind: 'partial',
      state: freezeState({ sessions: valid }),
      droppedEntries: dropped.count,
      backupPath,
    };
  }
  return { kind: 'fresh', state: freezeState({ sessions: valid }) };
}

// ---------------------------------------------------------------------------
// updateState — generic Mutator<T> with discriminated UpdateStateResult<T>
// ---------------------------------------------------------------------------

/**
 * Acquire the file lock, hand the mutator a mutable state, write the
 * result atomically, release. Returns the mutator's value on success.
 * A lock-acquisition failure returns `{ ok: false, reason: 'timeout' }`
 * rather than throwing.
 *
 * Mutator exceptions propagate — they indicate a programmer error, not an
 * I/O failure, so the caller (which is normally a hook script) can decide
 * how to log.
 */
export async function updateState<T>(
  mutator: Mutator<T>,
  options: UpdateStateOptions = {},
): Promise<UpdateStateResult<T>> {
  const path = options.path ?? idleStatePath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT;

  ensureStateFile(path);

  const release = await acquireLock(path, timeoutMs);
  if (release === null) {
    return { ok: false, reason: 'timeout' };
  }

  try {
    const current = readMutableState(path);
    const value = mutator(current);
    atomicWriteFile(path, JSON.stringify(current, null, 2) + '\n');
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

// ---------------------------------------------------------------------------
// Named helpers (primary API — see rule 5 in the typing standards)
// ---------------------------------------------------------------------------

/**
 * Read a single session entry without touching the lock. Returns a frozen
 * snapshot on success, `{ ok: false, reason: 'not_found' }` otherwise.
 * Pure read; never times out.
 */
export function takeSessionSnapshot(
  id: SessionId,
  options: Pick<UpdateStateOptions, 'path'> = {},
): SnapshotResult {
  const result = readState(options.path);
  const entry = result.state.sessions[id];
  if (entry === undefined) {
    return { ok: false, reason: 'not_found' };
  }
  return { ok: true, snapshot: freezeEntry(entry) };
}

/**
 * If the session has `pending_checkin` set and isn't disabled, clear the
 * flag, record a fresh `last_checkin_at`, append to `checkins`, and return
 * a frozen snapshot of the entry as it existed *before* the reset. The
 * tool-call counter is reset in the same transaction so the next threshold
 * check starts from zero.
 */
export async function consumePendingCheckin(
  id: SessionId,
  options: UpdateStateOptions = {},
): Promise<ConsumePendingResult> {
  const result = await updateState<ConsumePendingResult>((state) => {
    const entry = state.sessions[id];
    if (entry === undefined) {
      return { ok: false, reason: 'not_found' };
    }
    if (entry.disabled === true) {
      return { ok: false, reason: 'disabled' };
    }
    if (entry.pending_checkin !== true) {
      return { ok: false, reason: 'not_pending' };
    }

    const snapshot = freezeEntry({ ...entry });
    const now = nowIso();
    entry.pending_checkin = false;
    entry.tool_calls_since_checkin = 0;
    entry.subagent_tool_calls_since_checkin = 0;
    entry.last_checkin_at = now;
    entry.checkins = [...entry.checkins, now];
    return { ok: true, entry: snapshot, cleared: true };
  }, options);

  if (!result.ok) {
    return { ok: false, reason: 'timeout' };
  }
  return result.value;
}

/**
 * Record a tool call against the session: bump counters, stash the last
 * tool name/summary, and set `pending_checkin` if either threshold trips.
 * Reports whether the threshold tripped so the caller doesn't need a
 * second read. Short-circuits on a disabled session.
 *
 * Thresholds are passed in rather than loaded here so `state.ts` stays
 * independent of `config.ts` — the hook script loads config once and hands
 * the thresholds down.
 */
export async function incrementToolCounter(
  id: SessionId,
  tool: ToolCall,
  thresholds: Readonly<ThresholdsConfig>,
  options: UpdateStateOptions = {},
): Promise<IncrementToolResult> {
  const result = await updateState<IncrementToolResult>((state) => {
    const entry = state.sessions[id];
    if (entry === undefined) {
      return { ok: false, reason: 'not_found' };
    }
    if (entry.disabled === true) {
      return { ok: false, reason: 'disabled' };
    }

    entry.tool_calls_since_checkin += 1;
    entry.total_tool_calls += 1;
    entry.last_tool_name = tool.name;
    entry.last_tool_summary = truncate(tool.summary, 200);

    const totalCalls =
      entry.tool_calls_since_checkin +
      (entry.subagent_tool_calls_since_checkin ?? 0);
    const minutesSince = minutesSinceCheckin(entry);

    const callThresholdTripped =
      thresholds.tool_calls > 0 && totalCalls >= thresholds.tool_calls;
    const timeThresholdTripped =
      thresholds.time_minutes > 0 && minutesSince >= thresholds.time_minutes;
    const thresholdTripped = callThresholdTripped || timeThresholdTripped;

    if (thresholdTripped) {
      entry.pending_checkin = true;
    }
    return { ok: true, thresholdTripped };
  }, options);

  if (!result.ok) {
    return { ok: false, reason: 'timeout' };
  }
  return result.value;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function emptyState(): SessionState {
  return { sessions: {} };
}

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
 * Read state for mutation. Corrupt or missing files yield an empty state
 * (corrupt files are backed up first). Per-entry invalid sessions are
 * stripped and backed up to a `-entries` sidecar so the mutator operates
 * on a clean shape. Always returns a mutable object — the caller is
 * about to hand it to a mutator.
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

/**
 * Create an empty state file if and only if one does not already exist,
 * atomically. Uses `openSync(path, 'wx')` so we never stomp on state
 * written by another process racing this ensure — that used to be the
 * source of the cross-process "lost update" bug.
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
    writeSync(fd, JSON.stringify(emptyState(), null, 2) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function isAlreadyExists(err: unknown): err is NodeJS.ErrnoException {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === 'EEXIST'
  );
}

function atomicWriteFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const fd = openSync(tmp, 'w', 0o644);
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function backupCorruptFile(path: string, cause: unknown): string {
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

/**
 * Weaker check than isValidSessionEntry — just asserts the top-level shape
 * `{ sessions: object }`. Entries inside are validated separately.
 */
function hasPlainSessionsMap(
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

interface PartitionResult {
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
function partitionEntries(input: Record<string, unknown>): PartitionResult {
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
 * Persist dropped entries to a sidecar file so the operator can inspect
 * what was lost. Never throws — a backup failure must not cascade into a
 * hook abort.
 */
function backupDroppedEntries(
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

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function minutesSinceCheckin(entry: SessionEntry): number {
  const anchor = entry.last_checkin_at ?? entry.started_at;
  const then = Date.parse(anchor);
  if (!Number.isFinite(then)) return 0;
  return Math.max(0, (Date.now() - then) / 60_000);
}

// ---------------------------------------------------------------------------
// Deep-freeze helpers for public snapshots
// ---------------------------------------------------------------------------

function freezeEntry(entry: SessionEntry): Readonly<SessionEntry> {
  Object.freeze(entry.checkins);
  return Object.freeze(entry);
}

function freezeState(state: SessionState): Readonly<SessionState> {
  for (const entry of Object.values(state.sessions)) {
    freezeEntry(entry);
  }
  Object.freeze(state.sessions);
  return Object.freeze(state);
}
