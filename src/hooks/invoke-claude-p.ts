/**
 * Subprocess helper for `claude -p`. Separated from `src/hooks/stop.ts` so
 * it's a real ESM import seam — `vi.mock('./invoke-claude-p.js')` from the
 * hook tests intercepts reliably. Production callers only see
 * `invokeClaudeP()` returning `Promise<ClaudeResult>`; `execClaudeLike()`
 * is exported for integration tests against `tests/fixtures/fake-claude-p.mjs`.
 *
 * Uses `spawn` with explicit `stdio: ['ignore', 'pipe', 'pipe']` (F-012).
 * The `'ignore'` on stdin is load-bearing: the `claude` CLI blocks up to
 * ~3s reading stdin before consuming the argv prompt. Under Claude Code's
 * ~5s hook timeout, an open stdin pipe causes external SIGTERM before
 * notification delivery (exit 143 in debug.log). Ignoring stdin gives the
 * child immediate EOF. Argv is passed directly with no shell, so
 * LLM-generated backticks / `$()` / `;` in the prompt cannot escape.
 *
 * stderr with zero exit is NOT a hard failure: logged at debug, stdout
 * still returned as `rawOutput`. Non-zero exit maps to `'nonzero'`.
 * ENOENT, timeout (we initiate SIGTERM via setTimeout), and other signals
 * are categorized separately.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

import { log } from '../lib/log.js';

/** Production timeout for `claude -p`. 8s per design Decision Y. */
export const CLAUDE_P_TIMEOUT_MS = 8_000;

/** Maximum stdout/stderr capture. Output is normalized to 200 chars downstream. */
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
 * `process.execPath` and exercise real spawn timeout / ENOENT / signal
 * behavior without mocking `node:child_process`.
 */
export async function execClaudeLike(
  binary: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<ClaudeResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(binary, [...args], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      // Synchronous spawn failure is rare on modern Node (ENOENT surfaces
      // via 'error'), but be defensive.
      const e = (err ?? {}) as { code?: string; message?: string };
      if (e.code === 'ENOENT') {
        log('debug', 'invoke-claude-p: binary not found (ENOENT)');
        resolve({ ok: false, reason: 'enoent' });
        return;
      }
      log('debug', 'invoke-claude-p: spawn threw synchronously', {
        code: e.code,
        message: e.message,
      });
      resolve({ ok: false, reason: 'nonzero' });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let bufferExceeded = false;
    let timedOut = false;
    let settled = false;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    // Don't let our deadline keep the event loop alive beyond the child.
    timeoutHandle.unref?.();

    const settle = (result: ClaudeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve(result);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (bufferExceeded) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > CLAUDE_P_MAX_BUFFER) {
        bufferExceeded = true;
        child.kill('SIGTERM');
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (bufferExceeded) return;
      stderrBytes += chunk.length;
      if (stderrBytes > CLAUDE_P_MAX_BUFFER) {
        bufferExceeded = true;
        child.kill('SIGTERM');
        return;
      }
      stderrChunks.push(chunk);
    });

    child.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        log('debug', 'invoke-claude-p: binary not found (ENOENT)');
        settle({ ok: false, reason: 'enoent' });
        return;
      }
      log('debug', 'invoke-claude-p: spawn error', {
        code: err.code,
        message: err.message,
      });
      settle({ ok: false, reason: 'nonzero' });
    });

    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');

      if (timedOut) {
        log('debug', 'invoke-claude-p: timed out', {
          timeout_signal: signal,
          stderr: stderr.length > 0 ? truncate(stderr) : undefined,
        });
        settle({ ok: false, reason: 'timeout' });
        return;
      }

      if (bufferExceeded) {
        log('debug', 'invoke-claude-p: maxBuffer exceeded', {
          signal,
          stderr: stderr.length > 0 ? truncate(stderr) : undefined,
        });
        settle({ ok: false, reason: 'nonzero' });
        return;
      }

      if (signal !== null) {
        log('debug', 'invoke-claude-p: killed by signal', {
          signal,
          killed: false,
          stderr: stderr.length > 0 ? truncate(stderr) : undefined,
        });
        settle({ ok: false, reason: 'killed' });
        return;
      }

      if (code === 0) {
        if (stderr.length > 0) {
          log('debug', 'invoke-claude-p: stderr on zero exit', {
            stderr: truncate(stderr),
          });
        }
        settle({ ok: true, rawOutput: stdout });
        return;
      }

      log('debug', 'invoke-claude-p: nonzero exit', {
        exit_code: code,
        stderr: stderr.length > 0 ? truncate(stderr) : undefined,
      });
      settle({ ok: false, reason: 'nonzero' });
    });
  });
}

function truncate(s: string): string {
  const limit = 500;
  return s.length > limit ? s.slice(0, limit) : s;
}
