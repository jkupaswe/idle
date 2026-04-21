/**
 * Subprocess helper for `claude -p`. Separated from `src/hooks/stop.ts` so
 * it's a real ESM import seam — `vi.mock('./invoke-claude-p.js')` from the
 * hook tests intercepts reliably. Production callers only see
 * `invokeClaudeP()` returning `Promise<ClaudeResult>`; `execClaudeLike()`
 * is exported for integration tests against `tests/fixtures/fake-claude-p.mjs`.
 *
 * Uses `execFile` (not `spawn`, not `exec`) via `util.promisify` — argv
 * items are passed directly, no shell interpretation. LLM-generated prompt
 * content can contain backticks, `$()`, `;`, etc., but cannot escape into
 * a shell because there is no shell.
 *
 * stderr with zero exit is NOT a hard failure: logged at debug, stdout
 * still returned as `rawOutput`. Non-zero exit maps to `'nonzero'`.
 * ENOENT, timeout (SIGTERM from the timeout option), and other signals
 * are categorized separately.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { log } from '../lib/log.js';

const execFileP = promisify(execFile);

/** Production timeout for `claude -p`. 8s per design Decision Y. */
export const CLAUDE_P_TIMEOUT_MS = 8_000;

/** Maximum stdout capture. Output is normalized to 200 chars downstream. */
export const CLAUDE_P_MAX_BUFFER = 64 * 1024;

export type ClaudeResult =
  | { readonly ok: true; readonly rawOutput: string }
  | {
      readonly ok: false;
      readonly reason: 'timeout' | 'enoent' | 'nonzero' | 'killed';
    };

/**
 * Production entry point. Runs `claude -p <prompt>` with the settled
 * defaults and returns the categorized result. Never throws — every
 * failure mode collapses into `{ ok: false, reason }`.
 */
export async function invokeClaudeP(prompt: string): Promise<ClaudeResult> {
  return execClaudeLike('claude', ['-p', prompt], CLAUDE_P_TIMEOUT_MS);
}

/**
 * Module-local helper. Production code does not call this directly; it
 * exists so integration tests can invoke the fake-claude fixture via
 * `process.execPath` and exercise real `execFile` timeout / ENOENT /
 * signal behavior without mocking `node:child_process`.
 */
export async function execClaudeLike(
  binary: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<ClaudeResult> {
  try {
    const { stdout, stderr } = await execFileP(binary, [...args], {
      env: process.env,
      timeout: timeoutMs,
      maxBuffer: CLAUDE_P_MAX_BUFFER,
      windowsHide: true,
    });
    if (typeof stderr === 'string' && stderr.length > 0) {
      log('debug', 'invoke-claude-p: stderr on zero exit', {
        stderr: truncate(stderr),
      });
    }
    return { ok: true, rawOutput: typeof stdout === 'string' ? stdout : String(stdout) };
  } catch (err) {
    return categorize(err);
  }
}

interface ExecFailure {
  code?: number | string;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stderr?: string | Buffer;
  message?: string;
}

function categorize(err: unknown): ClaudeResult {
  const e = (err ?? {}) as ExecFailure;
  const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf8') ?? '';

  if (e.code === 'ENOENT') {
    log('debug', 'invoke-claude-p: binary not found (ENOENT)');
    return { ok: false, reason: 'enoent' };
  }

  // The timeout option kills with the default signal (SIGTERM) and sets
  // `err.killed = true`. Externally delivered SIGTERM (e.g. parent
  // orchestrator, `kill` from another tool) must NOT be classified as a
  // timeout — execFile only sets `killed` when IT initiated the kill
  // (timeout / maxBuffer). Without the killed=true guard the helper
  // misreports foreign SIGTERMs (codex-review-2 finding 3).
  if (e.signal === 'SIGTERM' && e.killed === true) {
    log('debug', 'invoke-claude-p: timed out', {
      timeout_signal: e.signal,
      stderr: stderr.length > 0 ? truncate(stderr) : undefined,
    });
    return { ok: false, reason: 'timeout' };
  }
  if (typeof e.signal === 'string' && e.signal.length > 0) {
    log('debug', 'invoke-claude-p: killed by signal', {
      signal: e.signal,
      killed: e.killed === true,
      stderr: stderr.length > 0 ? truncate(stderr) : undefined,
    });
    return { ok: false, reason: 'killed' };
  }

  if (typeof e.code === 'number' && e.code !== 0) {
    log('debug', 'invoke-claude-p: nonzero exit', {
      exit_code: e.code,
      stderr: stderr.length > 0 ? truncate(stderr) : undefined,
    });
    return { ok: false, reason: 'nonzero' };
  }

  // Fallback — shape didn't match any known category. Treat as nonzero so
  // the hook falls through to the silent body rather than silently missing.
  log('debug', 'invoke-claude-p: uncategorized failure', {
    message: typeof e.message === 'string' ? e.message : String(err),
    code: e.code,
    signal: e.signal ?? null,
  });
  return { ok: false, reason: 'nonzero' };
}

function truncate(s: string): string {
  const limit = 500;
  return s.length > limit ? s.slice(0, limit) : s;
}
