/**
 * Stop hook — fires when the agent finishes responding.
 *
 * If a `pending_checkin` flag has been set by PostToolUse, the hook
 * constructs a one-sentence break suggestion via `claude -p` (or the
 * silent-preset body) and triggers a native notification. Otherwise it
 * exits 0 silently.
 *
 * Installed with `async: false` (per CLAUDE.md): Claude Code blocks on
 * completion, so every path must terminate quickly and without silent loss.
 *
 * Flow control is split into a two-phase try/catch (see design doc §5):
 *
 * - OUTER TRY wraps pre-consume work (stdin parse, guards, the
 *   `consumePendingCheckin` call itself). An unexpected throw here logs at
 *   `error` and exits 0 with NO notify — the pending flag is still set so
 *   the next Stop event retries cleanly.
 *
 * - INNER TRY starts the moment `consumePendingCheckin` returns `ok:true`.
 *   The flag is already cleared atomically; from that point every error
 *   path must attempt a notification. An unexpected throw lands in the
 *   inner catch, which fires the tier-3 `"Idle check-in"` fallback with the
 *   `notifOpts` accumulated so far (sound/method forwarded from config
 *   when it loaded) and exits 0.
 *
 * Contract:
 * - Never writes to stdout (Claude Code uses stdout for hook protocol).
 * - Exits 0 on every path.
 * - Uses `consumePendingCheckin` (atomic read-and-clear) — never hand-rolls
 *   pending-flag logic.
 * - Does not pass `isSubagent` or sum subagent counters (F-003, deferred).
 * - Does not add a second layer of tool-data sanitization — templates
 *   handle it via `sanitizeUntrustedField`.
 */

import { pathToFileURL } from 'node:url';

import {
  ConfigParseError,
  ConfigValidationError,
  defaultConfig,
  loadConfig,
} from '../core/config.js';
import { notify } from '../core/notify.js';
import type { NotifyInput } from '../core/notify.js';
import { consumePendingCheckin } from '../core/state.js';
import { log } from '../lib/log.js';
import type {
  CheckInStats,
  IdleConfig,
  SessionEntry,
  SessionId,
  TonePreset,
} from '../lib/types.js';
import { isSessionId } from '../lib/types.js';
import { buildPrompt as buildAbsurdist } from '../prompts/absurdist.js';
import { buildPrompt as buildDry } from '../prompts/dry.js';
import { buildPrompt as buildEarnest } from '../prompts/earnest.js';
import { buildPrompt as buildSilent } from '../prompts/silent.js';

import { invokeClaudeP } from './invoke-claude-p.js';
import { normalizeClaudeOutput } from './normalize-claude-output.js';

type TemplateBuilder = (stats: CheckInStats) => string;

const TEMPLATES: Readonly<Record<TonePreset, TemplateBuilder>> = {
  dry: buildDry,
  earnest: buildEarnest,
  absurdist: buildAbsurdist,
  silent: buildSilent,
};

/**
 * Execute the Stop hook against an already-read stdin buffer. Returns an
 * exit code. Never throws — every failure lands in one of the two catches.
 */
export async function run(input: string): Promise<number> {
  // -------------------------------------------------------------------------
  // [OUTER TRY] — pre-consume work. An unexpected throw here exits 0 with
  // NO notify; the pending flag is still set for the next Stop event.
  // -------------------------------------------------------------------------
  try {
    const payload = parsePayload(input);
    if (payload === null) return 0;

    if (payload.stop_hook_active === true) {
      log('debug', 'stop: re-entrant Stop, skipping');
      return 0;
    }

    if (!isSessionId(payload.session_id)) {
      log('warn', 'stop: invalid session_id', {
        session_id_type: typeof payload.session_id,
      });
      return 0;
    }

    const sessionId: SessionId = payload.session_id;
    const consume = await consumePendingCheckin(sessionId);

    if (!consume.ok) {
      switch (consume.reason) {
        case 'not_pending':
          // Hot path — agent finished a turn without having tripped a
          // threshold. Nothing to do, nothing to log.
          return 0;
        case 'not_found':
        case 'disabled':
          log('debug', 'stop: consume skipped', {
            session_id: sessionId,
            reason: consume.reason,
          });
          return 0;
        case 'timeout':
          // `_updateState` enforces its deadline both BEFORE and AFTER the
          // atomic write (see state.internal.ts). A `timeout` result therefore
          // cannot distinguish "pending flag still set, retry safe" from
          // "flag already cleared, retry will see not_pending". The second
          // case silently drops the user's check-in, so we prefer a
          // possibly-duplicate tier-3 notification over silent loss. The
          // next Stop will fire again normally if the write never landed.
          log(
            'warn',
            'stop: consume timed out; state ambiguous, firing tier-3 to avoid silent loss',
            { session_id: sessionId },
          );
          await notifyTimeoutTier3();
          return 0;
      }
    }

    // -----------------------------------------------------------------------
    // [INNER TRY] — starts IMMEDIATELY after consumePendingCheckin returns
    // ok:true. From here on, every throw must attempt a notification
    // (tier-3 "Idle check-in") so the user's check-in is not silently lost.
    // -----------------------------------------------------------------------
    let notifOpts: NotifyInput = { title: 'Idle', body: 'Idle check-in' };
    let configLoaded = false;
    try {
      const config = safeLoadConfig();
      notifOpts = {
        ...notifOpts,
        sound: config.notifications.sound,
        method: config.notifications.method,
      };
      configLoaded = true;

      const stats = buildStats(consume.entry);
      const silentBody = TEMPLATES.silent(stats);

      if (config.tone.preset === 'silent') {
        await notify({ ...notifOpts, body: silentBody });
        return 0;
      }

      const prompt = TEMPLATES[config.tone.preset](stats);
      const result = await invokeClaudeP(prompt);

      if (!result.ok) {
        log('debug', 'stop: claude invocation failed; falling back', {
          reason: result.reason,
        });
        await notify({ ...notifOpts, body: silentBody });
        return 0;
      }

      const body = normalizeClaudeOutput(result.rawOutput);
      if (body === '') {
        log('debug', 'stop: claude empty after normalize; falling back');
        await notify({ ...notifOpts, body: silentBody });
        return 0;
      }

      await notify({ ...notifOpts, body });
      return 0;
    } catch (err) {
      log('error', 'stop: post-consume unexpected throw', {
        config_loaded: configLoaded,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      await notify({ ...notifOpts, body: 'Idle check-in' });
      return 0;
    }
  } catch (err) {
    log('error', 'stop: pre-consume unexpected throw', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return 0;
  }
}

interface StopFields {
  session_id: unknown;
  stop_hook_active?: boolean;
}

function parsePayload(input: string): StopFields | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (err) {
    log('warn', 'stop: stdin is not valid JSON', {
      error: err instanceof Error ? err.message : String(err),
      length: input.length,
    });
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log('warn', 'stop: stdin is not a JSON object', {
      kind: Array.isArray(parsed) ? 'array' : typeof parsed,
    });
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const stopHookActive =
    typeof obj.stop_hook_active === 'boolean' ? obj.stop_hook_active : undefined;
  return {
    session_id: obj.session_id,
    ...(stopHookActive !== undefined ? { stop_hook_active: stopHookActive } : {}),
  };
}

/**
 * Tier-3 notification for the `consume` timeout branch. Loads config so
 * `sound` and `method` are forwarded (users with `method='terminal'` are
 * still honored). `safeLoadConfig` and `notify` are both never-throw; no
 * try/catch needed. Kept separate from the inner try/catch so the outer
 * catch still covers it as a last-line-of-defense.
 */
async function notifyTimeoutTier3(): Promise<void> {
  const config = safeLoadConfig();
  await notify({
    title: 'Idle',
    body: 'Idle check-in',
    sound: config.notifications.sound,
    method: config.notifications.method,
  });
}

function safeLoadConfig(): Readonly<IdleConfig> {
  try {
    return loadConfig();
  } catch (err) {
    log('warn', 'stop: config load failed, using defaults', {
      error: err instanceof Error ? err.message : String(err),
      kind:
        err instanceof ConfigParseError
          ? 'parse'
          : err instanceof ConfigValidationError
            ? 'validation'
            : 'unknown',
    });
    return defaultConfig();
  }
}

function buildStats(entry: Readonly<SessionEntry>): CheckInStats {
  const startedAt = Date.parse(entry.started_at);
  const durationMs = Number.isFinite(startedAt) ? Date.now() - startedAt : 0;
  const duration_minutes = Math.max(0, Math.floor(durationMs / 60_000));
  const stats: CheckInStats = {
    duration_minutes,
    tool_calls: entry.tool_calls_since_checkin,
  };
  if (entry.last_tool_name !== undefined) {
    stats.last_tool_name = entry.last_tool_name;
  }
  if (entry.last_tool_summary !== undefined) {
    stats.last_tool_summary = entry.last_tool_summary;
  }
  return stats;
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
    log('error', 'stop: unexpected crash', {
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
