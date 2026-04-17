/**
 * Load, save, and validate `~/.idle/config.toml`.
 *
 * Typing posture (see CLAUDE.md + Core typing standards):
 * - Values arriving from TOML are `unknown` until narrowed by type guards.
 * - Public APIs return `Readonly<IdleConfig>`; the returned object is
 *   deep-frozen at runtime so callers can't silently mutate shared state.
 * - Failure paths are discriminated-union results (`{ ok: true, ... }` /
 *   `{ ok: false, errors }`), not optional fields.
 * - Errors are typed classes (`ConfigParseError`, `ConfigValidationError`)
 *   with structured properties; no string-throwing, no regex-ready messages.
 *
 * Responsibilities:
 * - `defaultConfig()` — fresh default config per PRD §6.2.
 * - `loadConfig()` — read + parse + validate; throws on malformed input.
 *   Missing file → defaults (does NOT create the file).
 * - `saveConfig()` — validate and atomically persist (temp + fsync + rename).
 * - `validateConfig()` — narrow an `unknown` into a valid config or a list
 *   of `ValidationIssue`s. Fills defaults for missing keys; rejects values
 *   of the wrong type or outside the allowed set.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

import TOML from '@iarna/toml';

import { idleConfigPath } from '../lib/paths.js';
import { TONE_PRESETS } from '../lib/types.js';
import type {
  IdleConfig,
  NotificationMethod,
  NotificationsConfig,
  ProjectOverride,
  ThresholdsConfig,
  ToneConfig,
  TonePreset,
} from '../lib/types.js';

// ---------------------------------------------------------------------------
// Branded types
// ---------------------------------------------------------------------------

/**
 * String branded as an absolute filesystem path. Produced only by the
 * `isAbsolutePath` guard below — ordinary strings can't be passed anywhere
 * expecting an `AbsolutePath` without a compile-time error. Follow-up:
 * `IdleConfig.projects` in `src/lib/types.ts` still uses plain `string`
 * keys; branding that requires Architect-owned changes.
 */
export type AbsolutePath = string & { readonly __brand: 'AbsolutePath' };

/** Type guard: true when `value` is a POSIX absolute path string. */
export function isAbsolutePath(value: string): value is AbsolutePath {
  return value.length > 0 && value.startsWith('/');
}

// ---------------------------------------------------------------------------
// Validation result + errors
// ---------------------------------------------------------------------------

/** One validation failure, tagged with the dotted config path that failed. */
export interface ValidationIssue {
  /** Dotted path into the config (e.g. `"tone.preset"`). `""` for the root. */
  readonly path: string;
  /** Human-readable failure description. Safe to show the user. */
  readonly message: string;
}

/**
 * Result of `validateConfig`. Discriminated on `ok` so every caller has to
 * handle both arms — a forgotten `if (!result.ok)` is a compile error in
 * strict mode when the caller touches `result.config` directly.
 */
export type ValidationResult =
  | { readonly ok: true; readonly config: Readonly<IdleConfig> }
  | { readonly ok: false; readonly errors: readonly ValidationIssue[] };

/** Thrown by `loadConfig` when TOML syntax itself is broken. */
export class ConfigParseError extends Error {
  override readonly name = 'ConfigParseError' as const;
  /** Absolute path to the file that failed to parse. */
  readonly path: string;

  constructor(path: string, cause: unknown) {
    super(`Failed to parse TOML config at ${path}: ${errMessage(cause)}`, {
      cause: cause instanceof Error ? cause : undefined,
    });
    this.path = path;
  }
}

/** Thrown by `loadConfig`/`saveConfig` when the config fails semantic checks. */
export class ConfigValidationError extends Error {
  override readonly name = 'ConfigValidationError' as const;
  /** Every validation issue that applied. Never empty. */
  readonly errors: readonly ValidationIssue[];
  /** Path to the file, when the error came from `loadConfig`. */
  readonly path: string | null;

  constructor(errors: readonly ValidationIssue[], path: string | null = null) {
    super(formatIssues(errors, path));
    this.errors = errors;
    this.path = path;
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const NOTIFICATION_METHODS = ['native', 'terminal', 'both'] as const;

/**
 * Factory for the default Idle config. Returns a fresh object per call so
 * callers can safely mutate the result without affecting others (or the
 * cached defaults of a later call).
 */
export function defaultConfig(): IdleConfig {
  return {
    thresholds: { time_minutes: 45, tool_calls: 40 },
    tone: { preset: 'dry' },
    notifications: { method: 'native', sound: false },
    projects: {},
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the Idle config from disk. Missing file → frozen defaults (file is
 * NOT created). Malformed TOML throws `ConfigParseError`; semantically
 * invalid values (wrong type, unknown tone preset, non-absolute project
 * key, etc.) throw `ConfigValidationError`. Missing fields within a valid
 * file are filled from defaults.
 */
export function loadConfig(path: string = idleConfigPath()): Readonly<IdleConfig> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return freezeConfig(defaultConfig());
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = TOML.parse(raw);
  } catch (err) {
    throw new ConfigParseError(path, err);
  }

  const result = validateConfig(parsed);
  if (!result.ok) {
    throw new ConfigValidationError(result.errors, path);
  }
  return result.config;
}

/**
 * Write `config` to disk atomically (temp file → fsync → rename). Refuses
 * to write an invalid config — throws `ConfigValidationError` first. Creates
 * parent directories as needed.
 */
export function saveConfig(
  config: Readonly<IdleConfig>,
  path: string = idleConfigPath(),
): void {
  const result = validateConfig(config);
  if (!result.ok) {
    throw new ConfigValidationError(result.errors);
  }
  atomicWriteFile(path, TOML.stringify(toTomlMap(result.config)));
}

/**
 * Narrow an `unknown` value to a valid Idle config, filling defaults for any
 * missing field. Present-but-invalid values produce a `ValidationIssue` and
 * are NOT silently replaced — callers get a hard error rather than a
 * surprising fallback.
 */
export function validateConfig(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const base = defaultConfig();

  if (input === undefined) {
    return { ok: true, config: freezeConfig(base) };
  }
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: '', message: 'config must be a table' }],
    };
  }

  const thresholds = readThresholds(input.thresholds, base.thresholds, issues);
  const tone = readTone(input.tone, base.tone, issues);
  const notifications = readNotifications(
    input.notifications,
    base.notifications,
    issues,
  );
  const projects = readProjects(input.projects, issues);

  if (issues.length > 0) {
    return { ok: false, errors: issues };
  }
  return {
    ok: true,
    config: freezeConfig({ thresholds, tone, notifications, projects }),
  };
}

// ---------------------------------------------------------------------------
// Section readers — each narrows `unknown` → the typed shape, recording
// issues along the way. Missing → base. Wrong type → base + issue.
// ---------------------------------------------------------------------------

function readThresholds(
  input: unknown,
  base: ThresholdsConfig,
  issues: ValidationIssue[],
): ThresholdsConfig {
  if (input === undefined) return { ...base };
  if (!isPlainObject(input)) {
    issues.push({ path: 'thresholds', message: 'must be a table' });
    return { ...base };
  }
  return {
    time_minutes: readNonNegativeInt(
      input.time_minutes,
      'thresholds.time_minutes',
      base.time_minutes,
      issues,
    ),
    tool_calls: readNonNegativeInt(
      input.tool_calls,
      'thresholds.tool_calls',
      base.tool_calls,
      issues,
    ),
  };
}

function readTone(
  input: unknown,
  base: ToneConfig,
  issues: ValidationIssue[],
): ToneConfig {
  if (input === undefined) return { ...base };
  if (!isPlainObject(input)) {
    issues.push({ path: 'tone', message: 'must be a table' });
    return { ...base };
  }
  const preset = readTonePreset(input.preset, base.preset, issues);
  return { preset };
}

function readNotifications(
  input: unknown,
  base: NotificationsConfig,
  issues: ValidationIssue[],
): NotificationsConfig {
  if (input === undefined) return { ...base };
  if (!isPlainObject(input)) {
    issues.push({ path: 'notifications', message: 'must be a table' });
    return { ...base };
  }
  const method = readNotificationMethod(input.method, base.method, issues);
  const sound = readBoolean(
    input.sound,
    'notifications.sound',
    base.sound,
    issues,
  );
  return { method, sound };
}

function readProjects(
  input: unknown,
  issues: ValidationIssue[],
): Record<string, ProjectOverride> {
  if (input === undefined) return {};
  if (!isPlainObject(input)) {
    issues.push({ path: 'projects', message: 'must be a table' });
    return {};
  }

  const out: Record<string, ProjectOverride> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!isAbsolutePath(key)) {
      issues.push({
        path: `projects["${key}"]`,
        message: 'key must be an absolute filesystem path',
      });
      continue;
    }
    if (!isPlainObject(value) || typeof value.enabled !== 'boolean') {
      issues.push({
        path: `projects["${key}"]`,
        message: 'must be a table with a boolean "enabled" field',
      });
      continue;
    }
    out[key] = { enabled: value.enabled };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scalar readers
// ---------------------------------------------------------------------------

function readNonNegativeInt(
  value: unknown,
  path: string,
  base: number,
  issues: ValidationIssue[],
): number {
  if (value === undefined) return base;
  if (isNonNegativeInt(value)) return value;
  issues.push({ path, message: 'must be a non-negative integer' });
  return base;
}

function readBoolean(
  value: unknown,
  path: string,
  base: boolean,
  issues: ValidationIssue[],
): boolean {
  if (value === undefined) return base;
  if (typeof value === 'boolean') return value;
  issues.push({ path, message: 'must be a boolean' });
  return base;
}

function readTonePreset(
  value: unknown,
  base: TonePreset,
  issues: ValidationIssue[],
): TonePreset {
  if (value === undefined) return base;
  if (isTonePreset(value)) return value;
  issues.push({
    path: 'tone.preset',
    message: `must be one of: ${TONE_PRESETS.join(', ')}`,
  });
  return base;
}

function readNotificationMethod(
  value: unknown,
  base: NotificationMethod,
  issues: ValidationIssue[],
): NotificationMethod {
  if (value === undefined) return base;
  if (isNotificationMethod(value)) return value;
  issues.push({
    path: 'notifications.method',
    message: `must be one of: ${NOTIFICATION_METHODS.join(', ')}`,
  });
  return base;
}

// ---------------------------------------------------------------------------
// Guards (used internally and tested indirectly via validateConfig)
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isTonePreset(value: unknown): value is TonePreset {
  return typeof value === 'string' && TONE_PRESETS.some((p) => p === value);
}

function isNotificationMethod(value: unknown): value is NotificationMethod {
  return (
    typeof value === 'string' &&
    NOTIFICATION_METHODS.some((m) => m === value)
  );
}

function isNotFound(err: unknown): err is NodeJS.ErrnoException {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === 'ENOENT'
  );
}

// ---------------------------------------------------------------------------
// Serialization + atomic write
// ---------------------------------------------------------------------------

function toTomlMap(c: Readonly<IdleConfig>): TOML.JsonMap {
  const projects: TOML.JsonMap = {};
  for (const [key, value] of Object.entries(c.projects)) {
    projects[key] = { enabled: value.enabled };
  }
  return {
    thresholds: {
      time_minutes: c.thresholds.time_minutes,
      tool_calls: c.thresholds.tool_calls,
    },
    tone: { preset: c.tone.preset },
    notifications: {
      method: c.notifications.method,
      sound: c.notifications.sound,
    },
    projects,
  };
}

function atomicWriteFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const fd = openSync(tmp, 'w', 0o644);
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Deep-freeze + misc
// ---------------------------------------------------------------------------

function freezeConfig(c: IdleConfig): Readonly<IdleConfig> {
  Object.freeze(c.thresholds);
  Object.freeze(c.tone);
  Object.freeze(c.notifications);
  for (const v of Object.values(c.projects)) Object.freeze(v);
  Object.freeze(c.projects);
  return Object.freeze(c);
}

function formatIssues(
  issues: readonly ValidationIssue[],
  path: string | null,
): string {
  const prefix = path === null ? 'Invalid Idle config' : `Invalid Idle config at ${path}`;
  const body = issues
    .map((i) => (i.path === '' ? i.message : `${i.path}: ${i.message}`))
    .join('; ');
  return `${prefix}: ${body}`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
