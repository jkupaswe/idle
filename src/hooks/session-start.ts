/**
 * SessionStart hook — invoked by Claude Code at the beginning of a session.
 *
 * Reads the Claude Code hook payload from stdin, validates `session_id` and
 * `cwd`, and registers the session in `~/.idle/state.json` via the
 * `registerSession` helper. The per-project `disabled` flag is derived from
 * the config's per-project override.
 *
 * Contract:
 * - Never writes to stdout (Claude Code captures stdout for protocol use).
 * - Exits 0 on every path, including malformed input. Failures are logged to
 *   `~/.idle/debug.log` and swallowed — a broken hook must not break the
 *   user's Claude Code session.
 * - Uses `registerSession` from `src/core/state.ts`. Does NOT reach for the
 *   private `_updateState` primitive.
 * - Installed as `npx tsx /abs/path/src/hooks/session-start.ts # idle:v1`
 *   with `async: true` in `~/.claude/settings.json`.
 */

import { pathToFileURL } from 'node:url';

import { isAbsolutePath, loadConfig } from '../core/config.js';
import { registerSession } from '../core/state.js';
import { log } from '../lib/log.js';
import { nowIso } from '../lib/time.js';
import type { AbsolutePath, IdleConfig, SessionEntry } from '../lib/types.js';
import { isSessionId } from '../lib/types.js';

/**
 * Execute the SessionStart hook against an already-read stdin buffer.
 *
 * Returns an exit code. Never throws. Unit tests drive this directly;
 * the module's top-level runner reads stdin and forwards here.
 */
export async function run(input: string): Promise<number> {
  const payload = parsePayload(input);
  if (payload === null) {
    // parsePayload already logged the specific failure.
    return 0;
  }

  const { session_id, cwd } = payload;

  if (!isSessionId(session_id)) {
    log('warn', 'session-start: invalid session_id', {
      session_id_type: typeof session_id,
    });
    return 0;
  }

  if (typeof cwd !== 'string' || !isAbsolutePath(cwd)) {
    log('warn', 'session-start: invalid cwd', { cwd_type: typeof cwd });
    return 0;
  }

  const config = safeLoadConfig();
  const disabled = isProjectDisabled(config, cwd);

  const entry: SessionEntry = {
    started_at: nowIso(),
    project_path: cwd,
    tool_calls_since_checkin: 0,
    total_tool_calls: 0,
    last_checkin_at: null,
    checkins: [],
    ...(disabled ? { disabled: true } : {}),
  };

  const result = await registerSession(session_id, entry);
  if (!result.ok) {
    if (result.reason === 'already_exists') {
      // Claude Code re-fires SessionStart on resume/clear/compact; treat as
      // idempotent rather than clobbering in-flight state.
      log('debug', 'session-start: session already registered', {
        session_id,
      });
    } else {
      log('warn', 'session-start: registerSession failed', {
        session_id,
        reason: result.reason,
      });
    }
    return 0;
  }

  log('info', 'session-start: session registered', {
    session_id,
    project_path: cwd,
    disabled,
  });
  return 0;
}

function parsePayload(input: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (err) {
    log('warn', 'session-start: stdin is not valid JSON', {
      error: err instanceof Error ? err.message : String(err),
      length: input.length,
    });
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log('warn', 'session-start: stdin is not a JSON object', {
      kind: Array.isArray(parsed) ? 'array' : typeof parsed,
    });
    return null;
  }
  return parsed as Record<string, unknown>;
}

function safeLoadConfig(): Readonly<IdleConfig> | null {
  try {
    return loadConfig();
  } catch (err) {
    log('warn', 'session-start: config load failed, proceeding without overrides', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function isProjectDisabled(
  config: Readonly<IdleConfig> | null,
  cwd: AbsolutePath,
): boolean {
  if (config === null) return false;
  const override = config.projects[cwd];
  return override !== undefined && override.enabled === false;
}

// ---------------------------------------------------------------------------
// Entry point — invoked by Claude Code via `npx tsx ... # idle:v1`.
// Guarded so unit tests can import `run` without triggering stdin reads.
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
    log('error', 'session-start: unexpected crash', {
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
