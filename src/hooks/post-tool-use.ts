/**
 * PostToolUse hook — fires after every tool call the agent completes.
 *
 * This is the hot path. PRD §7 caps added latency at <50ms. The hook is
 * installed with `async: true`, so Claude Code does not block on it, but
 * the work still needs to be efficient: one JSON parse, one config read,
 * one atomic state mutation via `incrementToolCounter`, exit.
 *
 * `incrementToolCounter` is fail-open with a 200ms default budget. We do
 * not override that — on a slow filesystem, missing one tool-call tick is
 * preferable to blocking the user's next prompt.
 *
 * Contract:
 * - Never writes to stdout.
 * - Exits 0 on every path.
 * - Uses the named helper; never touches `_updateState`.
 * - Subagent tracking is deferred to F-003; `ToolCall` is `{ name, summary }`.
 */

import { pathToFileURL } from 'node:url';

import { defaultConfig, loadConfig } from '../core/config.js';
import { incrementToolCounter } from '../core/state.js';
import { log } from '../lib/log.js';
import type { IdleConfig } from '../lib/types.js';
import { isSessionId } from '../lib/types.js';

import { summarizeToolInput } from './tool-summary.js';

/**
 * Execute the PostToolUse hook against an already-read stdin buffer.
 * Returns an exit code. Never throws.
 */
export async function run(input: string): Promise<number> {
  const payload = parsePayload(input);
  if (payload === null) return 0;

  const { session_id, tool_name, tool_input } = payload;

  if (!isSessionId(session_id)) {
    log('warn', 'post-tool-use: invalid session_id', {
      session_id_type: typeof session_id,
    });
    return 0;
  }

  if (typeof tool_name !== 'string' || tool_name.length === 0) {
    log('warn', 'post-tool-use: invalid tool_name', {
      tool_name_type: typeof tool_name,
    });
    return 0;
  }

  const summary = summarizeToolInput(tool_name, tool_input);
  const config = safeLoadConfig();

  const result = await incrementToolCounter(
    session_id,
    { name: tool_name, summary },
    config.thresholds,
  );

  if (!result.ok) {
    const level = result.reason === 'timeout' ? 'warn' : 'debug';
    log(level, 'post-tool-use: increment skipped', {
      session_id,
      reason: result.reason,
    });
    return 0;
  }

  if (result.thresholdTripped) {
    log('info', 'post-tool-use: threshold tripped', { session_id });
  }
  return 0;
}

interface PostToolUseFields {
  session_id: unknown;
  tool_name: unknown;
  tool_input: unknown;
}

function parsePayload(input: string): PostToolUseFields | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (err) {
    log('warn', 'post-tool-use: stdin is not valid JSON', {
      error: err instanceof Error ? err.message : String(err),
      length: input.length,
    });
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log('warn', 'post-tool-use: stdin is not a JSON object', {
      kind: Array.isArray(parsed) ? 'array' : typeof parsed,
    });
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  return {
    session_id: obj.session_id,
    tool_name: obj.tool_name,
    tool_input: obj.tool_input,
  };
}

function safeLoadConfig(): Readonly<IdleConfig> {
  try {
    return loadConfig();
  } catch (err) {
    log('warn', 'post-tool-use: config load failed, using defaults', {
      error: err instanceof Error ? err.message : String(err),
    });
    return defaultConfig();
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
    log('error', 'post-tool-use: unexpected crash', {
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
