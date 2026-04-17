/**
 * Shared timestamp helpers.
 *
 * Two concerns, both shared across Wave 2:
 *
 * 1. ISO-8601 "now" strings for log entries and on-disk timestamps.
 * 2. Filesystem-safe timestamp suffixes for backup and corruption files
 *    (e.g. `settings.json.idle-backup-<suffix>`, `state.json.corrupt-<suffix>`).
 *
 * T-005 (state.ts) and T-006 (settings.ts) MUST consume `timestampSuffix()`
 * rather than formatting their own — otherwise backups written by different
 * modules won't sort or collide predictably.
 */

/**
 * Return the current moment as an ISO-8601 string (millisecond precision,
 * UTC). Stable across tests because it takes `now` as a parameter.
 */
export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

/**
 * Return a filesystem-safe timestamp suffix, suitable for appending to a
 * backup or corrupt-file name.
 *
 * Format: `YYYYMMDDTHHMMSSsssZ` — derived from ISO-8601 with the separators
 * stripped so it's safe on every POSIX filesystem and sorts lexicographically.
 *
 * Example: `state.json.corrupt-20260416T230530123Z`.
 */
export function timestampSuffix(now: Date = new Date()): string {
  return now.toISOString().replace(/[-:.]/g, '');
}
