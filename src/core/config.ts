/**
 * Load and save `~/.idle/config.toml`.
 *
 * Responsibilities:
 * - Provide a `defaultConfig()` factory matching PRD §6.2.
 * - `loadConfig()` reads the TOML, applies defaults for missing keys,
 *   returns a fully-typed `IdleConfig`. Missing file → defaults (no create).
 * - `saveConfig()` writes TOML atomically (temp + rename).
 * - `validateConfig()` returns either `{valid: true}` or `{valid: false, errors}`.
 *
 * Safety: all writes under `~/.idle/` go through an atomic
 * write-temp-then-rename path. Never `writeFileSync` the config directly.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

import TOML from '@iarna/toml';

import { idleConfigPath } from '../lib/paths.js';
import { TONE_PRESETS } from '../lib/types.js';
import type {
  IdleConfig,
  NotificationMethod,
  ProjectOverride,
  TonePreset,
} from '../lib/types.js';

/** Result of `validateConfig`. */
export type ValidationResult =
  | { valid: true }
  | { valid: false; errors: string[] };

const NOTIFICATION_METHODS: readonly NotificationMethod[] = [
  'native',
  'terminal',
  'both',
] as const;

/**
 * Factory for the default Idle config. New object on every call so callers
 * can safely mutate the result without affecting other callers.
 */
export function defaultConfig(): IdleConfig {
  return {
    thresholds: {
      time_minutes: 45,
      tool_calls: 40,
    },
    tone: {
      preset: 'dry',
    },
    notifications: {
      method: 'native',
      sound: false,
    },
    projects: {},
  };
}

/**
 * Load the Idle config from `~/.idle/config.toml` (or its IDLE_HOME-rebased
 * equivalent). Missing file returns defaults and does NOT create the file.
 * Invalid TOML throws a descriptive error naming the file path.
 *
 * Partial files are merged onto defaults: a user who only sets
 * `thresholds.time_minutes` still gets the rest of the defaults filled in.
 */
export function loadConfig(path: string = idleConfigPath()): IdleConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (isNotFound(err)) {
      return defaultConfig();
    }
    throw err;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = TOML.parse(raw) as Record<string, unknown>;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse TOML config at ${path}: ${detail}`);
  }

  return mergeWithDefaults(parsed);
}

/**
 * Write `config` to `~/.idle/config.toml` atomically.
 *
 * Implementation: write to `<path>.tmp-<pid>-<rand>`, fsync, rename over the
 * original. Creates parent directories as needed.
 */
export function saveConfig(
  config: IdleConfig,
  path: string = idleConfigPath(),
): void {
  const verdict = validateConfig(config);
  if (!verdict.valid) {
    throw new Error(
      `Refusing to save invalid Idle config: ${verdict.errors.join('; ')}`,
    );
  }

  const serialized = TOML.stringify(config as unknown as TOML.JsonMap);
  atomicWriteFile(path, serialized);
}

/**
 * Validate a config value. Returns `{ valid: true }` on success, otherwise a
 * list of human-readable error strings.
 *
 * Checks every field defined in `IdleConfig` for correct type and allowed
 * values. Does not mutate. Used by `saveConfig` and by the `doctor` CLI.
 */
export function validateConfig(config: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isPlainObject(config)) {
    return { valid: false, errors: ['config must be an object'] };
  }

  const thresholds = config.thresholds;
  if (!isPlainObject(thresholds)) {
    errors.push('thresholds must be a table');
  } else {
    if (!isNonNegativeInt(thresholds.time_minutes)) {
      errors.push('thresholds.time_minutes must be a non-negative integer');
    }
    if (!isNonNegativeInt(thresholds.tool_calls)) {
      errors.push('thresholds.tool_calls must be a non-negative integer');
    }
  }

  const tone = config.tone;
  if (!isPlainObject(tone)) {
    errors.push('tone must be a table');
  } else if (!isTonePreset(tone.preset)) {
    errors.push(
      `tone.preset must be one of: ${TONE_PRESETS.join(', ')}`,
    );
  }

  const notifications = config.notifications;
  if (!isPlainObject(notifications)) {
    errors.push('notifications must be a table');
  } else {
    if (!isNotificationMethod(notifications.method)) {
      errors.push(
        `notifications.method must be one of: ${NOTIFICATION_METHODS.join(', ')}`,
      );
    }
    if (typeof notifications.sound !== 'boolean') {
      errors.push('notifications.sound must be a boolean');
    }
  }

  const projects = config.projects;
  if (!isPlainObject(projects)) {
    errors.push('projects must be a table');
  } else {
    for (const [key, value] of Object.entries(projects)) {
      if (!isPlainObject(value) || typeof value.enabled !== 'boolean') {
        errors.push(`projects["${key}"] must have an "enabled" boolean`);
      }
    }
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function mergeWithDefaults(parsed: Record<string, unknown>): IdleConfig {
  const base = defaultConfig();

  const thresholds = isPlainObject(parsed.thresholds) ? parsed.thresholds : {};
  const tone = isPlainObject(parsed.tone) ? parsed.tone : {};
  const notifications = isPlainObject(parsed.notifications)
    ? parsed.notifications
    : {};
  const projects = isPlainObject(parsed.projects) ? parsed.projects : {};

  return {
    thresholds: {
      time_minutes: isNonNegativeInt(thresholds.time_minutes)
        ? thresholds.time_minutes
        : base.thresholds.time_minutes,
      tool_calls: isNonNegativeInt(thresholds.tool_calls)
        ? thresholds.tool_calls
        : base.thresholds.tool_calls,
    },
    tone: {
      preset: isTonePreset(tone.preset) ? tone.preset : base.tone.preset,
    },
    notifications: {
      method: isNotificationMethod(notifications.method)
        ? notifications.method
        : base.notifications.method,
      sound:
        typeof notifications.sound === 'boolean'
          ? notifications.sound
          : base.notifications.sound,
    },
    projects: normalizeProjects(projects),
  };
}

function normalizeProjects(
  input: Record<string, unknown>,
): Record<string, ProjectOverride> {
  const out: Record<string, ProjectOverride> = {};
  for (const [key, value] of Object.entries(input)) {
    if (isPlainObject(value) && typeof value.enabled === 'boolean') {
      out[key] = { enabled: value.enabled };
    }
  }
  return out;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value)
  );
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isTonePreset(value: unknown): value is TonePreset {
  return (
    typeof value === 'string' &&
    (TONE_PRESETS as readonly string[]).includes(value)
  );
}

function isNotificationMethod(value: unknown): value is NotificationMethod {
  return (
    typeof value === 'string' &&
    (NOTIFICATION_METHODS as readonly string[]).includes(value)
  );
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'ENOENT'
  );
}
