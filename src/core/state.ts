/**
 * Public state API for Idle hooks and CLI commands.
 *
 * The named helpers below are the ONLY supported way to mutate
 * `~/.idle/state.json`. The low-level mutator primitive lives in
 * `state.internal.ts` and is deliberately not re-exported here so callers
 * can't bypass the brand / timeout / threshold guarantees these helpers
 * enforce.
 *
 * Public surface (alphabetical):
 * - `DEFAULT_LOCK_TIMEOUT`
 * - `ReadStateResult`, `SnapshotResult`, `ConsumePendingResult`,
 *   `IncrementToolResult`, `RegisterSessionResult`, `RemoveSessionResult`
 * - `UpdateStateOptions`, `ToolCall`
 * - `readState`
 * - `registerSession`
 * - `removeSession`
 * - `takeSessionSnapshot`
 * - `consumePendingCheckin`
 * - `incrementToolCounter`
 *
 * Corruption model (per Decision E): `readState` partitions entries; a
 * malformed entry is backed up to a sidecar and the caller receives
 * `{ kind: 'partial', droppedEntries, backupPath }`. Full-file corruption
 * still yields `{ kind: 'recovered', corruptBackupPath }`.
 */

import { readFileSync } from 'node:fs';

import { log } from '../lib/log.js';
import { idleStatePath } from '../lib/paths.js';
import { nowIso } from '../lib/time.js';
import type {
  SessionEntry,
  SessionId,
  SessionState,
  ThresholdsConfig,
} from '../lib/types.js';

import { ms } from '../lib/types.js';
import type { Milliseconds } from '../lib/types.js';

import {
  _updateState,
  backupCorruptFile,
  backupDroppedEntries,
  emptyState,
  freezeEntry,
  freezeState,
  hasPlainSessionsMap,
  minutesSinceCheckin,
  partitionEntries,
  truncate,
} from './state.internal.js';

// ---------------------------------------------------------------------------
// Public constants and options — canonical in this file. `state.internal.ts`
// intentionally mirrors the 5s default and accepts a structurally-equivalent
// options shape so consumers never have two import paths for the same value.
// ---------------------------------------------------------------------------

/** Default lock-acquisition budget for state mutations. 5s. */
export const DEFAULT_LOCK_TIMEOUT: Milliseconds = ms(5_000);

/**
 * Default wall-clock budget for the PostToolUse hot path. The wall-clock
 * enforcement in `_updateState` means this is a real ceiling for
 * `incrementToolCounter`, not just a lock-acquisition retry budget: if
 * filesystem I/O stalls past it, the call returns a timeout result.
 */
export const INCREMENT_TOOL_COUNTER_TIMEOUT: Milliseconds = ms(200);

/** Options accepted by every named mutation helper. */
export interface UpdateStateOptions {
  /** Override `~/.idle/state.json`. Used by tests. */
  readonly path?: string;
  /** Maximum wait, in milliseconds. Defaults to `DEFAULT_LOCK_TIMEOUT`. */
  readonly timeoutMs?: Milliseconds;
}

// ---------------------------------------------------------------------------
// Public result unions
// ---------------------------------------------------------------------------

/**
 * Outcome of `readState()`. Always carries a `Readonly<SessionState>` —
 * callers can continue regardless of which arm fires.
 *
 * - `fresh` — file parsed cleanly, every entry valid.
 * - `empty` — file missing (not an error).
 * - `recovered` — top-level JSON/schema failure; whole file backed up.
 * - `partial` — file parsed, but one or more entries failed
 *   `isValidSessionEntry`. Dropped entries are written to a
 *   `state.json.corrupt-<suffix>-entries` sidecar; the state returned
 *   contains only the valid entries.
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

/** Outcome of `incrementToolCounter(id, tool, thresholds)`. */
export type IncrementToolResult =
  | { readonly ok: true; readonly thresholdTripped: boolean }
  | {
      readonly ok: false;
      readonly reason: 'not_found' | 'disabled' | 'timeout';
    };

/** Outcome of `registerSession(id, entry)`. */
export type RegisterSessionResult =
  | { readonly ok: true; readonly entry: Readonly<SessionEntry> }
  | {
      readonly ok: false;
      readonly reason: 'already_exists' | 'timeout';
    };

/** Outcome of `removeSession(id)`. */
export type RemoveSessionResult =
  | {
      readonly ok: true;
      /** The removed entry (for archival), or null if there was nothing to remove. */
      readonly removed: Readonly<SessionEntry> | null;
    }
  | { readonly ok: false; readonly reason: 'timeout' };

/** The write-relevant slice of a PostToolUse payload. */
export interface ToolCall {
  readonly name: string;
  readonly summary: string;
}

// ---------------------------------------------------------------------------
// readState — discriminated union, no throws
// ---------------------------------------------------------------------------

/**
 * Read `~/.idle/state.json` and return a frozen snapshot. See
 * `ReadStateResult` for the recovery semantics.
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
// Named helpers (primary API)
// ---------------------------------------------------------------------------

/**
 * Read a single session entry without touching the lock. Returns a frozen
 * snapshot on success. Pure read; never times out.
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
 * Insert a new session entry under `id`. Fails if the id is already
 * present — production callers want fail-fast semantics so a
 * duplicate SessionStart doesn't clobber in-flight state.
 */
export async function registerSession(
  id: SessionId,
  entry: Readonly<SessionEntry>,
  options: UpdateStateOptions = {},
): Promise<RegisterSessionResult> {
  const result = await _updateState<RegisterSessionResult>((state) => {
    if (state.sessions[id] !== undefined) {
      return { ok: false, reason: 'already_exists' };
    }
    const clone: SessionEntry = {
      started_at: entry.started_at,
      project_path: entry.project_path,
      tool_calls_since_checkin: entry.tool_calls_since_checkin,
      total_tool_calls: entry.total_tool_calls,
      last_checkin_at: entry.last_checkin_at,
      checkins: [...entry.checkins],
      ...(entry.disabled !== undefined ? { disabled: entry.disabled } : {}),
      ...(entry.pending_checkin !== undefined
        ? { pending_checkin: entry.pending_checkin }
        : {}),
      ...(entry.last_tool_name !== undefined
        ? { last_tool_name: entry.last_tool_name }
        : {}),
      ...(entry.last_tool_summary !== undefined
        ? { last_tool_summary: entry.last_tool_summary }
        : {}),
      ...(entry.subagent_tool_calls_since_checkin !== undefined
        ? {
            subagent_tool_calls_since_checkin:
              entry.subagent_tool_calls_since_checkin,
          }
        : {}),
      ...(entry.total_subagent_tool_calls !== undefined
        ? { total_subagent_tool_calls: entry.total_subagent_tool_calls }
        : {}),
    };
    state.sessions[id] = clone;
    return { ok: true, entry: freezeEntry({ ...clone }) };
  }, options);

  if (!result.ok) return { ok: false, reason: 'timeout' };
  return result.value;
}

/**
 * Remove a session from the live state. Idempotent — removing an absent
 * session returns `{ ok: true, removed: null }`. SessionEnd hooks archive
 * via `takeSessionSnapshot` + write the archive file, then call this to
 * drop the entry.
 */
export async function removeSession(
  id: SessionId,
  options: UpdateStateOptions = {},
): Promise<RemoveSessionResult> {
  const result = await _updateState<RemoveSessionResult>((state) => {
    const entry = state.sessions[id];
    if (entry === undefined) {
      return { ok: true, removed: null };
    }
    delete state.sessions[id];
    return { ok: true, removed: freezeEntry({ ...entry }) };
  }, options);

  if (!result.ok) return { ok: false, reason: 'timeout' };
  return result.value;
}

/**
 * If the session has `pending_checkin` set and isn't disabled, clear the
 * flag, record a fresh `last_checkin_at`, append to `checkins`, and
 * return a frozen snapshot of the entry as it existed *before* the reset.
 * The tool-call counter is reset in the same transaction so the next
 * threshold check starts from zero.
 */
export async function consumePendingCheckin(
  id: SessionId,
  options: UpdateStateOptions = {},
): Promise<ConsumePendingResult> {
  const result = await _updateState<ConsumePendingResult>((state) => {
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

  if (!result.ok) return { ok: false, reason: 'timeout' };
  return result.value;
}

/**
 * Record a tool call against the session: bump counters, stash the last
 * tool name/summary, and set `pending_checkin` if either threshold trips.
 * Reports whether the threshold tripped so the caller doesn't need a
 * second read. Short-circuits on a disabled session.
 *
 * Thresholds are passed in rather than loaded here so `state.ts` stays
 * independent of `config.ts` — the hook loads config once and hands the
 * thresholds down.
 */
export async function incrementToolCounter(
  id: SessionId,
  tool: ToolCall,
  thresholds: Readonly<ThresholdsConfig>,
  options: UpdateStateOptions = {},
): Promise<IncrementToolResult> {
  // Hot-path default: ms(200). Callers can still override via options.
  const effective: UpdateStateOptions = {
    ...options,
    timeoutMs: options.timeoutMs ?? INCREMENT_TOOL_COUNTER_TIMEOUT,
  };
  const result = await _updateState<IncrementToolResult>((state) => {
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
  }, effective);

  if (!result.ok) return { ok: false, reason: 'timeout' };
  return result.value;
}

// ---------------------------------------------------------------------------
// Internals local to state.ts
// ---------------------------------------------------------------------------

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
