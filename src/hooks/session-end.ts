/**
 * SessionEnd hook — fires when a Claude Code session terminates.
 *
 * Archives the session entry to `~/.idle/sessions/<session_id>.json` and
 * removes it from live state. Written atomically so a crash between the
 * archive write and the state mutation leaves either (a) a valid archive
 * plus a still-present live entry, or (b) no archive plus the still-present
 * live entry — never a partial archive.
 *
 * Contract:
 * - Never writes to stdout.
 * - Exits 0 on every path.
 * - Uses `takeSessionSnapshot` + `removeSession`; no raw state access.
 * - Uses `atomicWriteFile` from `src/lib/fs.ts` for the archive write; no
 *   raw `fs.writeFileSync`.
 */

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { removeSession, takeSessionSnapshot } from '../core/state.js';
import { atomicWriteFile } from '../lib/fs.js';
import { log } from '../lib/log.js';
import { idleSessionsDir } from '../lib/paths.js';
import type { SessionEntry, SessionId } from '../lib/types.js';
import { isSessionId } from '../lib/types.js';

/**
 * Execute the SessionEnd hook against an already-read stdin buffer.
 * Returns an exit code. Never throws.
 */
export async function run(input: string): Promise<number> {
  const payload = parsePayload(input);
  if (payload === null) return 0;

  const { session_id } = payload;

  if (!isSessionId(session_id)) {
    log('warn', 'session-end: invalid session_id', {
      session_id_type: typeof session_id,
    });
    return 0;
  }

  const snapshot = takeSessionSnapshot(session_id);
  if (!snapshot.ok) {
    log('debug', 'session-end: no live session to end', {
      session_id,
      reason: snapshot.reason,
    });
    return 0;
  }

  writeSessionArchive(session_id, snapshot.snapshot);

  const removed = await removeSession(session_id);
  if (!removed.ok) {
    log('warn', 'session-end: removeSession failed', {
      session_id,
      reason: removed.reason,
    });
    return 0;
  }

  log('info', 'session-end: session archived and removed', {
    session_id,
    total_tool_calls: snapshot.snapshot.total_tool_calls,
  });
  return 0;
}

function parsePayload(input: string): { session_id: unknown } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (err) {
    log('warn', 'session-end: stdin is not valid JSON', {
      error: err instanceof Error ? err.message : String(err),
      length: input.length,
    });
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log('warn', 'session-end: stdin is not a JSON object', {
      kind: Array.isArray(parsed) ? 'array' : typeof parsed,
    });
    return null;
  }
  return { session_id: (parsed as Record<string, unknown>).session_id };
}

function writeSessionArchive(
  id: SessionId,
  snapshot: Readonly<SessionEntry>,
): void {
  const path = join(idleSessionsDir(), `${id}.json`);
  try {
    atomicWriteFile(path, JSON.stringify(snapshot, null, 2) + '\n');
  } catch (err) {
    log('warn', 'session-end: archive write failed', {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  try {
    const input = await readAllStdin();
    const code = await run(input);
    process.exit(code);
  } catch (err) {
    log('error', 'session-end: unexpected crash', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(0);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  void main();
}
