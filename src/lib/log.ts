/**
 * Debug logger for Idle.
 *
 * Appends one JSON object per line to `~/.idle/debug.log`. Hook scripts
 * cannot write to stdout (Claude Code uses stdout for the hook protocol),
 * so this file log is the only supported debug channel during hook
 * execution.
 *
 * The logger must never throw. If writing fails (missing directory,
 * permissions, full disk), the error is swallowed silently — a broken
 * debug log must not break a user's Claude Code session.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { idleDebugLog } from './paths.js';
import { nowIso } from './time.js';
import type { LogLevel } from './types.js';

/**
 * Append a structured log line to `~/.idle/debug.log`.
 *
 * The line is a JSON object with `ts`, `level`, `msg`, and optional `meta`.
 * Never throws.
 *
 * @param level  Severity level.
 * @param msg    Short human-readable message.
 * @param meta   Optional structured metadata. Must be JSON-serializable.
 */
export function log(level: LogLevel, msg: string, meta?: unknown): void {
  const entry: Record<string, unknown> = {
    ts: nowIso(),
    level,
    msg,
  };
  if (meta !== undefined) {
    entry.meta = meta;
  }

  let line: string;
  try {
    line = JSON.stringify(entry) + '\n';
  } catch {
    try {
      line =
        JSON.stringify({
          ts: entry.ts,
          level,
          msg,
          meta: '[unserializable]',
        }) + '\n';
    } catch {
      return;
    }
  }

  const path = idleDebugLog();
  try {
    appendFileSync(path, line, { encoding: 'utf8' });
  } catch {
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, line, { encoding: 'utf8' });
    } catch {
      // Give up silently — never break a hook on a log write.
    }
  }
}
