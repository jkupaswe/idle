/**
 * Pure normalization pipeline for `claude -p` stdout.
 *
 * Lives in its own module so the Stop hook (`src/hooks/stop.ts`) can import
 * it through a real ESM seam — enabling `vi.mock('./normalize-claude-output.js')`
 * for the tier-3 inner-catch test row. No mocks, no side effects.
 *
 * Pipeline:
 *   1. Strip ANSI escape sequences.
 *   2. Trim leading/trailing whitespace.
 *   3. Take the first non-empty line.
 *   4. Cap at 200 characters (matches `tool_input_summary` / OS notification
 *      truncation).
 *
 * An empty/whitespace-only input returns `''`. The caller — not this
 * function — decides whether to fall back to the silent-preset body.
 */

const MAX_LENGTH = 200;
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;

export function normalizeClaudeOutput(raw: string): string {
  const trimmed = raw.replace(ANSI_PATTERN, '').trim();
  if (trimmed.length === 0) return '';
  // `trimmed` is non-empty, so at least one split segment has non-whitespace
  // content; the `find` call returns that segment rather than undefined.
  const line = trimmed.split('\n').find((l) => l.trim().length > 0)!.trim();
  return line.length > MAX_LENGTH ? line.slice(0, MAX_LENGTH) : line;
}
