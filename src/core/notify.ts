/**
 * Cross-platform native notifications.
 *
 * - macOS: shell out to `osascript` with AppleScript `display notification`.
 * - Linux: shell out to `notify-send` when present, else fall back to stderr.
 * - Other platforms: fall back to stderr.
 *
 * Failures never throw. A Claude Code session must not break because a
 * notification couldn't be delivered.
 *
 * For tests, `IDLE_NOTIFY_PLATFORM` overrides `process.platform`, and the
 * module calls `child_process.execFile` (not `exec`), so mocks can be
 * installed via `vi.mock('node:child_process')`.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { log } from '../lib/log.js';
import type { NotificationMethod } from '../lib/types.js';

const execFileP = promisify(execFile);

export interface NotifyInput {
  /** Notification title (usually `"Idle"`). */
  title: string;
  /** Notification body — the break suggestion sentence. */
  body: string;
  /** When true and the platform supports it, play a sound. */
  sound?: boolean;
  /**
   * Delivery channel. Defaults to `'native'` (platform notifier with a
   * stderr fallback). `'terminal'` writes only to stderr, `'both'` attempts
   * native and writes to stderr independently. Unknown values are treated
   * as `'native'` for forward compatibility.
   */
  method?: NotificationMethod;
}

/**
 * Trigger a notification. Resolves regardless of delivery outcome; failures
 * are logged. Dispatches on `input.method`:
 *
 * - `'native'` (default / unknown value): platform notifier with a stderr
 *   fallback on failure or on platforms that lack one.
 * - `'terminal'`: stderr only. The platform notifier is never invoked.
 * - `'both'`: native (best-effort) AND stderr. A native failure does not
 *   suppress the terminal line, and vice versa.
 */
export async function notify(input: NotifyInput): Promise<void> {
  const { title, body, method } = input;

  if (method === 'terminal') {
    writeStderr(title, body);
    return;
  }

  const platform = currentPlatform();
  let nativeDelivered = false;

  try {
    if (platform === 'darwin') {
      await sendMac(input);
      nativeDelivered = true;
    } else if (platform === 'linux') {
      if (await hasNotifySend()) {
        await sendLinux(input);
        nativeDelivered = true;
      } else {
        log('warn', 'notify: notify-send not found');
      }
    }
    // Windows (v2) and any other platform: no native path available.
  } catch (err) {
    log('warn', 'notify: native delivery failed', {
      platform,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 'both': always also write stderr, independent of native outcome.
  // Default / 'native' / unknown: stderr only when native didn't deliver.
  if (method === 'both' || !nativeDelivered) {
    writeStderr(title, body);
  }
}

/**
 * Escape a string for safe embedding inside an AppleScript string literal.
 * AppleScript string literals are double-quoted; backslash and double-quote
 * are the only characters that need escaping.
 */
export function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Compose the `osascript -e` argument for a given input. */
export function buildMacAppleScript(input: NotifyInput): string {
  const body = escapeAppleScriptString(input.body);
  const title = escapeAppleScriptString(input.title);
  let script = `display notification "${body}" with title "${title}"`;
  if (input.sound) {
    script += ` sound name "Ping"`;
  }
  return script;
}

// ---------------------------------------------------------------------------
// Platform dispatch
// ---------------------------------------------------------------------------

async function sendMac(input: NotifyInput): Promise<void> {
  const script = buildMacAppleScript(input);
  await execFileP('osascript', ['-e', script]);
}

async function sendLinux(input: NotifyInput): Promise<void> {
  // The `--` separator tells notify-send to stop parsing CLI flags; every
  // argument after it is a positional value. Without this, a title or body
  // that happens to start with `-` (the body is model-generated text) would
  // be interpreted as an option — e.g. `-h` prints help instead of
  // delivering the notification. `execFile` already protects against shell
  // injection; `--` closes the argv-level equivalent.
  const args = ['--', input.title, input.body];
  await execFileP('notify-send', args);
}

async function hasNotifySend(): Promise<boolean> {
  try {
    await execFileP('which', ['notify-send']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the notification text to stderr, swallowing any error. The module
 * contract promises `notify()` never rejects — a stderr write that throws
 * (closed descriptor, EPIPE, monkey-patched host) must not propagate. The
 * previous implementation let the second-chance `writeStderr` inside the
 * top-level `catch` escape, which rejected the promise.
 */
function writeStderr(title: string, body: string): void {
  try {
    process.stderr.write(`${title}: ${body}\n`);
  } catch {
    // Intentionally empty. Losing a notification line is better than
    // breaking a Claude Code session.
  }
}

function currentPlatform(): NodeJS.Platform | string {
  const override = process.env.IDLE_NOTIFY_PLATFORM;
  if (override && override.length > 0) return override;
  return process.platform;
}
