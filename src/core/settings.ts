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

export interface InstallOptions {
  /**
   * Absolute path to the directory containing the four hook scripts. Defaults
   * to `<package-root>/src/hooks`, resolved from this file's location.
   */
  hooksDir?: string;
  /** Full path to settings.json. Defaults to `claudeSettingsPath()`. */
  settingsPath?: string;
}

export interface InstallResult {
  /** Path the backup was written to, or `null` if there was no prior file. */
  backupPath: string | null;
  /** Path that was written. */
  settingsPath: string;
}

/**
 * Add Idle's four hook entries to settings.json. Idempotent: running twice
 * leaves the file in the same state as running once.
 *
 * - Reads the existing settings (or `{}` if missing).
 * - Writes a backup to `<settings>.idle-backup-<suffix>`.
 * - Removes any pre-existing `# idle:v1` entries (ensures idempotency).
 * - Appends one command entry per event under matcher `""`.
 * - Writes atomically.
 */
export function installHooks(options: InstallOptions = {}): InstallResult {
  const settingsPath = options.settingsPath ?? claudeSettingsPath();
  const hooksDir = options.hooksDir ?? defaultHooksDir();

  const current = readSettings(settingsPath);
  const backupPath = backupIfPresent(settingsPath);
  const next = addIdleHooks(current, hooksDir);
  atomicWriteJson(settingsPath, next);
  return { backupPath, settingsPath };
}

export interface UninstallResult {
  backupPath: string | null;
  settingsPath: string;
  /** Number of Idle hook entries removed. */
  removed: number;
}

/**
 * Remove every Idle-tagged hook entry from settings.json. Empty matcher
 * groups are removed; an empty event array is removed; an empty `hooks`
 * object is removed. Preserves all other user keys.
 */
export function uninstallHooks(
  options: Pick<InstallOptions, 'settingsPath'> = {},
): UninstallResult {
  const settingsPath = options.settingsPath ?? claudeSettingsPath();
  const current = readSettings(settingsPath);
  const backupPath = backupIfPresent(settingsPath);
  const { next, removed } = removeIdleHooks(current);
  atomicWriteJson(settingsPath, next);
  return { backupPath, settingsPath, removed };
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
          command: commandFor(hook, hooksDir),
          async: true,
        }
      : {
          type: 'command',
          command: commandFor(hook, hooksDir),
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
  removed: number;
} {
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    return { next: settings, removed: 0 };
  }

  let removed = 0;
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
          h &&
          typeof h === 'object' &&
          typeof h.command === 'string' &&
          h.command.includes(IDLE_TAG);
        if (isIdle) removed += 1;
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
  return { next, removed };
}

function commandFor(hook: IdleHookEvent, hooksDir: string): string {
  const script = resolve(hooksDir, hook.script);
  return `npx tsx ${script} ${IDLE_TAG}`;
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

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'ENOENT'
  );
}
