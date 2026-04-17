/**
 * Merge and unmerge Idle's hook entries into the user's Claude Code
 * `~/.claude/settings.json`.
 *
 * Safety (per CLAUDE.md):
 * - Every write is atomic (write-temp-then-rename, fsync).
 * - Every install/uninstall copies a timestamped backup first.
 * - Install/uninstall is lossless and idempotent: repeated install → same
 *   result; install → uninstall → identical parsed content (see tests).
 *
 * Idle's hooks are identified by a trailing `# idle:v1` tag in the command
 * string. This lets uninstall find our hooks deterministically without
 * touching anything else the user has configured.
 */

import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { atomicWriteFile } from '../lib/fs.js';
import { claudeSettingsPath } from '../lib/paths.js';
import { timestampSuffix } from '../lib/time.js';

/** Tag appended to every Idle-owned command so uninstall can find them. */
export const IDLE_TAG = '# idle:v1';

/**
 * Discriminated union over the four Claude Code events Idle registers for.
 * The `async` flag and the `script` filename are locked to the event name
 * at compile time — a string-typed "which hook is this" can't float around
 * out of sync.
 *
 * `Stop` is the only synchronous hook: it runs `claude -p` and triggers the
 * notification, so Claude Code must block on it. The other three tick
 * counters / archive state and must never add latency to the tool-use
 * loop.
 */
export type IdleHookEvent =
  | { readonly event: 'SessionStart'; readonly async: true; readonly script: 'session-start.ts' }
  | { readonly event: 'PostToolUse'; readonly async: true; readonly script: 'post-tool-use.ts' }
  | { readonly event: 'Stop'; readonly async: false; readonly script: 'stop.ts' }
  | { readonly event: 'SessionEnd'; readonly async: true; readonly script: 'session-end.ts' };

/** The four event records Idle installs, in settings.json insertion order. */
export const IDLE_HOOK_EVENTS: readonly IdleHookEvent[] = [
  { event: 'SessionStart', async: true, script: 'session-start.ts' },
  { event: 'PostToolUse', async: true, script: 'post-tool-use.ts' },
  { event: 'Stop', async: false, script: 'stop.ts' },
  { event: 'SessionEnd', async: true, script: 'session-end.ts' },
] as const;

/** Just the event names, for iteration / type-level work. */
export const IDLE_EVENTS: readonly IdleHookEvent['event'][] =
  IDLE_HOOK_EVENTS.map((h) => h.event);

/** Literal event-name union. */
export type IdleEvent = IdleHookEvent['event'];

/** Literal script-filename union. */
export type IdleScript = IdleHookEvent['script'];

const IDLE_SCRIPTS: readonly IdleScript[] = IDLE_HOOK_EVENTS.map(
  (h) => h.script,
);

/**
 * True when `cmd` is structurally one of Idle's hook commands. Uses a
 * strict three-condition check — not `cmd.includes(IDLE_TAG)`, which
 * treats the tag as a substring anywhere in the command and removes
 * user hooks that merely mention it:
 *
 * 1. Starts with the exact prefix `npx tsx ` (the only form Idle emits).
 * 2. Ends with the exact suffix ` # idle:v1` (at end-of-string, no
 *    trailing characters).
 * 3. The middle — after stripping outer POSIX single-quotes that
 *    `buildHookCommand` may add for paths with special characters —
 *    has a basename matching one of the four Idle hook scripts.
 *
 * A user command like `echo keep me # idle:v1 but not idle` fails both
 * (1) and (2); `npx tsx foo.ts # idle:v1` fails (3). Only commands Idle
 * itself emits can slip through.
 */
export function isIdleOwnedCommand(cmd: string): boolean {
  const PREFIX = 'npx tsx ';
  const SUFFIX = ` ${IDLE_TAG}`;
  if (!cmd.startsWith(PREFIX)) return false;
  if (!cmd.endsWith(SUFFIX)) return false;

  const middle = cmd.slice(PREFIX.length, cmd.length - SUFFIX.length);
  const path = unquoteShellArg(middle);
  const basename = path.split('/').pop() ?? path;
  return IDLE_SCRIPTS.some((script) => basename === script);
}

/**
 * Reverse POSIX single-quote escaping produced by `shellEscape` (D4).
 * Leaves un-quoted arguments untouched. Non-POSIX shells aren't supported
 * here — Idle only emits single-quoted output.
 */
function unquoteShellArg(arg: string): string {
  if (arg.length >= 2 && arg.startsWith("'") && arg.endsWith("'")) {
    return arg.slice(1, -1).replace(/'\\''/g, "'");
  }
  return arg;
}

export interface InstallOptions {
  /**
   * Absolute path to the directory containing the four hook scripts. Defaults
   * to `<package-root>/src/hooks`, resolved from this file's location.
   */
  hooksDir?: string;
  /** Full path to settings.json. Defaults to `claudeSettingsPath()`. */
  settingsPath?: string;
}

/**
 * Outcome of `installHooks`. Discriminated union — forces callers to
 * handle each failure mode explicitly. `claude_not_installed` means the
 * Claude Code home directory isn't there; refuse rather than manufacture
 * one. `permission_denied` and `malformed_settings` are the I/O failure
 * modes worth surfacing separately (the CLI prints different remediation
 * for each).
 */
export type InstallResult =
  | {
      readonly ok: true;
      readonly installedEvents: readonly IdleEvent[];
      readonly backupPath: string | null;
      readonly settingsPath: string;
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'claude_not_installed'
        | 'permission_denied'
        | 'malformed_settings';
      readonly detail: string;
      readonly settingsPath: string;
    };

/**
 * Outcome of `uninstallHooks`. `fileExisted` distinguishes:
 * - `{ ok: true, removedEvents: [...], fileExisted: true }` — actually uninstalled.
 * - `{ ok: true, removedEvents: [], fileExisted: true }` — file present but had no idle hooks.
 * - `{ ok: true, removedEvents: [], fileExisted: false }` — no file at all; no-op.
 * The CLI layer uses `fileExisted` to pick the right user message.
 */
export type UninstallResult =
  | {
      readonly ok: true;
      readonly removedEvents: readonly IdleEvent[];
      readonly backupPath: string | null;
      readonly settingsPath: string;
      readonly fileExisted: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: 'permission_denied' | 'malformed_settings';
      readonly detail: string;
      readonly settingsPath: string;
    };

/**
 * Add Idle's four hook entries to settings.json. Idempotent: running twice
 * leaves the file in the same state as running once.
 *
 * - Reads the existing settings (or `{}` if missing).
 * - Writes a backup to `<settings>.idle-backup-<suffix>`.
 * - Removes any pre-existing Idle entries (keeps install idempotent).
 * - Appends one command entry per event under matcher `""`, with
 *   `async: true` on the three async events.
 * - Writes atomically.
 *
 * Failure modes are returned as `ok: false` — never thrown.
 */
export function installHooks(options: InstallOptions = {}): InstallResult {
  const settingsPath = options.settingsPath ?? claudeSettingsPath();
  const hooksDir = options.hooksDir ?? defaultHooksDir();

  if (!existsSync(dirname(settingsPath))) {
    return {
      ok: false,
      reason: 'claude_not_installed',
      detail: `Claude Code home directory not found: ${dirname(settingsPath)}`,
      settingsPath,
    };
  }

  let current: SettingsFile;
  try {
    current = readSettings(settingsPath);
  } catch (err) {
    return {
      ok: false,
      reason: 'malformed_settings',
      detail: errMessage(err),
      settingsPath,
    };
  }

  const backupPath = backupIfPresent(settingsPath);
  const next = addIdleHooks(current, hooksDir);

  try {
    atomicWriteJson(settingsPath, next);
  } catch (err) {
    if (isPermissionDenied(err)) {
      return {
        ok: false,
        reason: 'permission_denied',
        detail: errMessage(err),
        settingsPath,
      };
    }
    throw err;
  }

  return {
    ok: true,
    installedEvents: IDLE_HOOK_EVENTS.map((h) => h.event),
    backupPath,
    settingsPath,
  };
}

/**
 * Remove every Idle-owned hook entry from settings.json. Empty matcher
 * groups are removed; an empty event array is removed; an empty `hooks`
 * object is removed. Preserves all other user keys.
 *
 * Critical: uninstall on a file that does not exist is a true no-op —
 * it does NOT manufacture an empty settings.json (per PRD §6.1's
 * "restore exact prior state" requirement).
 */
export function uninstallHooks(
  options: Pick<InstallOptions, 'settingsPath'> = {},
): UninstallResult {
  const settingsPath = options.settingsPath ?? claudeSettingsPath();

  const fileExisted = existsSync(settingsPath);
  if (!fileExisted) {
    return {
      ok: true,
      removedEvents: [],
      backupPath: null,
      settingsPath,
      fileExisted: false,
    };
  }

  let current: SettingsFile;
  try {
    current = readSettings(settingsPath);
  } catch (err) {
    return {
      ok: false,
      reason: 'malformed_settings',
      detail: errMessage(err),
      settingsPath,
    };
  }

  const backupPath = backupIfPresent(settingsPath);
  const { next, removedEvents } = removeIdleHooks(current);

  try {
    atomicWriteJson(settingsPath, next);
  } catch (err) {
    if (isPermissionDenied(err)) {
      return {
        ok: false,
        reason: 'permission_denied',
        detail: errMessage(err),
        settingsPath,
      };
    }
    throw err;
  }

  return {
    ok: true,
    removedEvents,
    backupPath,
    settingsPath,
    fileExisted: true,
  };
}

// ---------------------------------------------------------------------------
// Data transforms
// ---------------------------------------------------------------------------

/**
 * Claude Code hook-command shape. `async: true` makes Claude Code fire the
 * handler in the background; omitting the field (or `false`) makes it
 * block on completion. Idle uses async for every event except Stop.
 */
interface HookCommand {
  type: 'command';
  command: string;
  async?: boolean;
  [extra: string]: unknown;
}

/** Matcher group: a matcher plus a list of hook commands. */
interface MatcherGroup {
  matcher: string;
  hooks: HookCommand[];
  [extra: string]: unknown;
}

type SettingsFile = { hooks?: Record<string, MatcherGroup[]>; [k: string]: unknown };

function addIdleHooks(
  settings: SettingsFile,
  hooksDir: string,
): SettingsFile {
  const cleaned = removeIdleHooks(settings).next;
  const hooks = { ...(cleaned.hooks ?? {}) };

  for (const hook of IDLE_HOOK_EVENTS) {
    const groups = [...(hooks[hook.event] ?? [])];
    const idx = groups.findIndex((g) => g.matcher === '');
    const idleCmd: HookCommand = hook.async
      ? {
          type: 'command',
          command: buildHookCommand(hook.script, hooksDir),
          async: true,
        }
      : {
          type: 'command',
          command: buildHookCommand(hook.script, hooksDir),
        };
    if (idx === -1) {
      groups.push({ matcher: '', hooks: [idleCmd] });
    } else {
      const existing = groups[idx]!;
      groups[idx] = {
        ...existing,
        hooks: [...(existing.hooks ?? []), idleCmd],
      };
    }
    hooks[hook.event] = groups;
  }

  return { ...cleaned, hooks };
}

function removeIdleHooks(settings: SettingsFile): {
  next: SettingsFile;
  removedEvents: readonly IdleEvent[];
} {
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    return { next: settings, removedEvents: [] };
  }

  const touched = new Set<string>();
  const hooksOut: Record<string, MatcherGroup[]> = {};

  for (const [event, rawGroups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(rawGroups)) {
      hooksOut[event] = rawGroups;
      continue;
    }
    const cleanedGroups: MatcherGroup[] = [];
    for (const group of rawGroups) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) {
        cleanedGroups.push(group);
        continue;
      }
      const cleanedHooks = group.hooks.filter((h) => {
        const isIdle =
          h !== null &&
          typeof h === 'object' &&
          typeof h.command === 'string' &&
          isIdleOwnedCommand(h.command);
        if (isIdle) touched.add(event);
        return !isIdle;
      });
      if (cleanedHooks.length > 0) {
        cleanedGroups.push({ ...group, hooks: cleanedHooks });
      }
    }
    if (cleanedGroups.length > 0) {
      hooksOut[event] = cleanedGroups;
    }
  }

  const next: SettingsFile = { ...settings };
  if (Object.keys(hooksOut).length === 0) {
    delete next.hooks;
  } else {
    next.hooks = hooksOut;
  }
  const removedEvents = IDLE_EVENTS.filter((e) => touched.has(e));
  return { next, removedEvents };
}

/**
 * Compose the hook command for one IdleHookEvent. Always POSIX
 * single-quote-wraps the script path so installing into directories
 * containing spaces, `$`, `*`, backticks, etc. produces a valid shell
 * command. `isIdleOwnedCommand` unquotes the middle on the way back
 * out.
 *
 * Exported so tests and the CLI can call it directly; the internal
 * install path uses it too.
 */
export function buildHookCommand(
  script: IdleScript,
  hooksDir: string,
): string {
  const absPath = resolve(hooksDir, script);
  return `npx tsx ${shellEscape(absPath)} ${IDLE_TAG}`;
}

/**
 * POSIX single-quote escape. Wraps the argument in single quotes and
 * encodes any literal single quote as `'\''` — close the current quoted
 * run, emit a backslash-escaped quote, reopen. Safe for every character
 * (single-quoted strings disable all expansion in POSIX shells).
 */
function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function readSettings(path: string): SettingsFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return {};
    throw err;
  }
  if (raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`expected JSON object, got ${typeof parsed}`);
    }
    return parsed as SettingsFile;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse Claude Code settings at ${path}: ${detail}`);
  }
}

function backupIfPresent(path: string): string | null {
  if (!existsSync(path)) return null;
  const backupPath = `${path}.idle-backup-${timestampSuffix()}`;
  copyFileSync(path, backupPath);
  return backupPath;
}

function atomicWriteJson(path: string, value: unknown): void {
  atomicWriteFile(path, JSON.stringify(value, null, 2) + '\n');
}

function defaultHooksDir(): string {
  // This file lives at <pkg>/src/core/settings.ts (or dist/core/settings.js
  // after build). Either way, `../hooks` relative to it points at the
  // hook scripts directory.
  const here = fileURLToPath(import.meta.url);
  return resolve(dirname(here), '..', 'hooks');
}

function isNotFound(err: unknown): err is NodeJS.ErrnoException {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === 'ENOENT'
  );
}

function isPermissionDenied(err: unknown): err is NodeJS.ErrnoException {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  const code = err.code;
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
