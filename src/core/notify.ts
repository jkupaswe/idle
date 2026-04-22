/**
 * Cross-platform native notifications.
 *
 * - macOS: shell out to `osascript` with AppleScript `display notification`.
 * - Linux: shell out to `notify-send` when present, else fall back to the
 *   terminal line.
 * - Other platforms: fall back to the terminal line.
 *
 * Terminal delivery prefers `/dev/tty` on POSIX so the line survives hook
 * runners that capture child-process stderr (Claude Code does). Falls back
 * to `process.stderr` on Windows and whenever no controlling terminal is
 * attached.
 *
 * Failures never throw. A Claude Code session must not break because a
 * notification couldn't be delivered.
 *
 * For tests, `IDLE_NOTIFY_PLATFORM` overrides `process.platform`, and the
 * module calls `child_process.execFile` (not `exec`), so mocks can be
 * installed via `vi.mock('node:child_process')`. Terminal writes go through
 * `node:fs` `openSync`/`writeSync`/`closeSync`, so `vi.mock('node:fs')` can
 * intercept them the same way.
 */

import { execFile } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';
import { promisify } from 'node:util';

import { log } from '../lib/log.js';
import type { NotificationMethod } from '../lib/types.js';

const execFileP = promisify(execFile);

// Per-subprocess wall-clock ceiling (Decision RR). 2000ms is the literal
// budget applied to osascript, notify-send, and which below. Stop is
// `async: false`, so an unbounded native-notifier call would block the
// user's next turn forever when a notifier wedges. Delivery is well under
// 2s on a healthy system; anything past that is a hang.

export interface NotifyInput {
  /** Notification title (usually `"Idle"`). */
  title: string;
  /** Notification body — the break suggestion sentence. */
  body: string;
  /** When true and the platform supports it, play a sound. */
  sound?: boolean;
  /**
   * Delivery channel. Defaults to `'native'` (platform notifier with a
   * terminal-line fallback). `'terminal'` writes only to the user's
   * terminal (prefers `/dev/tty`, falls back to stderr); `'both'` attempts
   * native and writes to the terminal independently. Unknown values are
   * treated as `'native'` for forward compatibility.
   */
  method?: NotificationMethod;
}

/**
 * Trigger a notification. Resolves regardless of delivery outcome; failures
 * are logged. Dispatches on `input.method`:
 *
 * - `'native'` (default / unknown value): platform notifier with a terminal
 *   fallback on failure or on platforms that lack one.
 * - `'terminal'`: terminal line only. The platform notifier is never invoked.
 * - `'both'`: native (best-effort) AND terminal line. A native failure does
 *   not suppress the terminal line, and vice versa.
 */
export async function notify(input: NotifyInput): Promise<void> {
  const { title, body, method } = input;

  if (method === 'terminal') {
    writeTerminal(title, body);
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

  // 'both': always also write the terminal line, independent of native
  // outcome. Default / 'native' / unknown: terminal line only when native
  // didn't deliver.
  if (method === 'both' || !nativeDelivered) {
    writeTerminal(title, body);
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
  await execFileP('osascript', ['-e', script], {
    timeout: 2000,
  });
}

async function sendLinux(input: NotifyInput): Promise<void> {
  // The `--` separator tells notify-send to stop parsing CLI flags; every
  // argument after it is a positional value. Without this, a title or body
  // that happens to start with `-` (the body is model-generated text) would
  // be interpreted as an option — e.g. `-h` prints help instead of
  // delivering the notification. `execFile` already protects against shell
  // injection; `--` closes the argv-level equivalent.
  const args = ['--', input.title, input.body];
  await execFileP('notify-send', args, {
    timeout: 2000,
  });
}

async function hasNotifySend(): Promise<boolean> {
  try {
    await execFileP('which', ['notify-send'], {
      timeout: 2000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the notification text to the user's terminal, swallowing any error.
 * The module contract promises `notify()` never rejects — a write that
 * throws (closed descriptor, EPIPE, monkey-patched host) must not propagate.
 *
 * On POSIX we prefer `/dev/tty` (the controlling terminal) over
 * `process.stderr`. Claude Code's hook runner captures child-process stderr
 * and does not forward it, so a stderr write in `method='terminal'` or
 * `method='both'` is invisible to the user when Idle runs inside Claude
 * Code. `/dev/tty` is owned by the terminal emulator rather than the
 * process tree, so it bypasses that capture. On Windows (or when no
 * controlling terminal is attached — piped, detached, CI) `/dev/tty` isn't
 * available and we fall back to stderr, preserving the previous behavior.
 */
function writeTerminal(title: string, body: string): void {
  const line = `${title}: ${body}\n`;

  if (currentPlatform() !== 'win32') {
    let fd: number | undefined;
    try {
      fd = openSync('/dev/tty', 'w');
      writeSync(fd, line);
      return;
    } catch {
      // No controlling TTY, permissions, or /dev/tty not writable. Fall
      // through to the stderr last-resort below.
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
      }
    }
  }

  try {
    process.stderr.write(line);
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
