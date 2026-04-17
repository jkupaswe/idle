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

import {
  accessSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import lockfile from 'proper-lockfile';

import { atomicWriteFile } from '../lib/fs.js';
import { log } from '../lib/log.js';
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
 * one. `timeout` means we couldn't acquire the settings lock within the
 * budget (another idle process or stale lockfile).
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
        | 'malformed_settings'
        | 'timeout';
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
      readonly reason: 'permission_denied' | 'malformed_settings' | 'timeout';
      readonly detail: string;
      readonly settingsPath: string;
    };

/** Budget for acquiring the settings.json file lock. */
const SETTINGS_LOCK_TIMEOUT_MS = 10_000;

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
export async function installHooks(
  options: InstallOptions = {},
): Promise<InstallResult> {
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

  const lockResult = await acquireSettingsLock(settingsPath);
  if (!lockResult.ok) {
    if (isPermissionDenied(lockResult.err)) {
      return classifyIoError(lockResult.err, settingsPath);
    }
    return {
      ok: false,
      reason: 'timeout',
      detail: `Could not acquire settings lock within ${SETTINGS_LOCK_TIMEOUT_MS}ms: ${settingsPath}`,
      settingsPath,
    };
  }

  try {
    let current: SettingsFile;
    try {
      current = readSettings(settingsPath);
    } catch (err) {
      return classifyIoError(err, settingsPath);
    }

    let backupPath: string | null;
    try {
      backupPath = backupIfPresent(settingsPath);
    } catch (err) {
      return classifyIoError(err, settingsPath);
    }

    const next = addIdleHooks(current, hooksDir);

    try {
      atomicWriteJson(settingsPath, next);
    } catch (err) {
      return classifyIoError(err, settingsPath);
    }

    return {
      ok: true,
      installedEvents: IDLE_HOOK_EVENTS.map((h) => h.event),
      backupPath,
      settingsPath,
    };
  } finally {
    try {
      await lockResult.release();
    } catch (err) {
      log('warn', 'settings: lock release failed', {
        settingsPath,
        error: errMessage(err),
      });
    }
  }
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
export async function uninstallHooks(
  options: Pick<InstallOptions, 'settingsPath'> = {},
): Promise<UninstallResult> {
  const settingsPath = options.settingsPath ?? claudeSettingsPath();

  // Missing file is a pure no-op; no lock needed, no file manufactured.
  if (!existsSync(settingsPath)) {
    return {
      ok: true,
      removedEvents: [],
      backupPath: null,
      settingsPath,
      fileExisted: false,
    };
  }

  const lockResult = await acquireSettingsLock(settingsPath);
  if (!lockResult.ok) {
    if (isPermissionDenied(lockResult.err)) {
      return classifyIoError(lockResult.err, settingsPath);
    }
    return {
      ok: false,
      reason: 'timeout',
      detail: `Could not acquire settings lock within ${SETTINGS_LOCK_TIMEOUT_MS}ms: ${settingsPath}`,
      settingsPath,
    };
  }

  try {
    // Re-check after taking the lock: another process may have removed
    // the file between the first existsSync and the lock acquisition.
    if (!existsSync(settingsPath)) {
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
      return classifyIoError(err, settingsPath);
    }

    let backupPath: string | null;
    try {
      backupPath = backupIfPresent(settingsPath);
    } catch (err) {
      return classifyIoError(err, settingsPath);
    }

    const { next, removedEvents } = removeIdleHooks(current);

    try {
      atomicWriteJson(settingsPath, next);
    } catch (err) {
      return classifyIoError(err, settingsPath);
    }

    return {
      ok: true,
      removedEvents,
      backupPath,
      settingsPath,
      fileExisted: true,
    };
  } finally {
    try {
      await lockResult.release();
    } catch (err) {
      log('warn', 'settings: lock release failed', {
        settingsPath,
        error: errMessage(err),
      });
    }
  }
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

/**
 * Always resolve to `<pkg-root>/src/hooks/`, whether this module is
 * running from `src/core/settings.ts` (dev / tsx) or from
 * `dist/core/settings.js` (built). The hook commands we install use
 * `npx tsx <path>/foo.ts`, so they must always point at the .ts
 * sources — dist/ contains .js files and the install would emit dead
 * paths.
 *
 * The function is exported (via {@link resolveHooksDirFromModule}) so
 * tests can verify both layouts end up at the same directory without
 * reaching into import.meta.url.
 */
function defaultHooksDir(): string {
  return resolveHooksDirFromModule(fileURLToPath(import.meta.url));
}

/**
 * Testable core of {@link defaultHooksDir}: given the absolute path of
 * this module's on-disk location (either `src/core/settings.ts` or
 * `dist/core/settings.js`), walk up to the package root and descend
 * into `src/hooks/`.
 *
 * Both layouts sit two directories below the package root
 * (`<pkg>/{src|dist}/core/<file>`), so going up two and into
 * `src/hooks/` works for either.
 */
export function resolveHooksDirFromModule(moduleFile: string): string {
  const pkgRoot = resolve(dirname(moduleFile), '..', '..');
  return resolve(pkgRoot, 'src', 'hooks');
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

/**
 * Produce a failure result for an I/O or parse error encountered during
 * install / uninstall. Permission-class errors route to
 * `permission_denied`; everything else (including the explicit parse
 * errors from `readSettings`) routes to `malformed_settings`.
 *
 * Kept in one place so the three call sites (read, backup, write) can't
 * drift — the round-4 code had EACCES mislabeled as `malformed_settings`
 * and a backup failure that wasn't caught at all.
 */
/**
 * Acquire a proper-lockfile lock on the settings path so two concurrent
 * installers can't lose updates in a read-modify-write race. Atomic
 * rename alone prevents partial writes but not cross-process update
 * loss — that's what this guards against.
 *
 * Uses `realpath: false` so it works even when settings.json doesn't
 * exist yet (the parent directory's existence is checked by the caller
 * via `claude_not_installed`).
 *
 * Returns a discriminated result so the caller can distinguish a real
 * contention timeout from a permission error on the `.lock` directory —
 * the latter would otherwise retry the mkdir for the full budget with
 * zero chance of success.
 */
async function acquireSettingsLock(settingsPath: string): Promise<
  | { readonly ok: true; readonly release: () => Promise<void> }
  | { readonly ok: false; readonly err: unknown }
> {
  // Fail fast on clearly unwritable parents. proper-lockfile would
  // retry mkdir for the entire budget otherwise, and EACCES on a
  // directory is deterministic — no amount of retrying helps.
  try {
    accessSync(dirname(settingsPath), fsConstants.W_OK);
  } catch (err) {
    return { ok: false, err };
  }

  const retries = Math.max(
    1,
    Math.floor(SETTINGS_LOCK_TIMEOUT_MS / 100),
  );
  try {
    const release = await lockfile.lock(settingsPath, {
      realpath: false,
      retries: {
        retries,
        minTimeout: 100,
        maxTimeout: 100,
        factor: 1,
        randomize: false,
      },
      stale: 30_000,
    });
    return { ok: true, release };
  } catch (err) {
    log('warn', 'settings: lock acquisition failed', {
      settingsPath,
      error: errMessage(err),
    });
    return { ok: false, err };
  }
}

function classifyIoError(
  err: unknown,
  settingsPath: string,
): {
  readonly ok: false;
  readonly reason: 'permission_denied' | 'malformed_settings';
  readonly detail: string;
  readonly settingsPath: string;
} {
  if (isPermissionDenied(err)) {
    return {
      ok: false,
      reason: 'permission_denied',
      detail: errMessage(err),
      settingsPath,
    };
  }
  return {
    ok: false,
    reason: 'malformed_settings',
    detail: errMessage(err),
    settingsPath,
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
