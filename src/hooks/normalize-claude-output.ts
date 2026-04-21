/**
 * Pure normalization pipeline for `claude -p` stdout.
 *
 * Lives in its own module so the Stop hook (`src/hooks/stop.ts`) can import
 * it through a real ESM seam — enabling `vi.mock('./normalize-claude-output.js')`
 * for the tier-3 inner-catch test row. No mocks, no side effects.
 *
 * Pipeline:
 *   1. Strip terminal escape sequences (CSI, OSC, single-char Fe) and bare
 *      control bytes (preserving TAB / LF / CR for line-splitting).
 *   2. Trim leading/trailing whitespace.
 *   3. Take the first non-empty line.
 *   4. Cap at 200 characters (matches `tool_input_summary` / OS notification
 *      truncation).
 *
 * Terminal-escape stripping matters even though `claude -p` is
 * non-interactive: the output is eventually written to stderr
 * (`method='terminal'` or the native-fallback path in `notify()`), and an
 * OSC hyperlink / title-setter in model output would otherwise reach the
 * user's terminal unchanged. Defense-in-depth.
 *
 * An empty/whitespace-only input returns `''`. The caller — not this
 * function — decides whether to fall back to the silent-preset body.
 */

const MAX_LENGTH = 200;

/* eslint-disable no-control-regex */
// CSI: ESC [ ... final-byte. `?` is included for private-mode sequences.
const CSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]/g;
// OSC: ESC ] ... terminator (BEL or ESC \). Non-greedy between the
// introducer and terminator, excluding embedded ESC/BEL so a broken/
// unterminated OSC can't swallow the rest of the string.
const OSC_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// Fe single-char escapes: ESC followed by one of @ A-Z [ \ ] ^ _ (0x40-0x5F).
const FE_PATTERN = /\x1b[@-Z\\-_]/g;
// Bare control bytes NOT consumed by the escape patterns above. Keep TAB
// (\x09), LF (\x0a), CR (\x0d) so the first-non-empty-line step still
// works; space is \x20 and outside the range.
const BARE_CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
/* eslint-enable no-control-regex */

function stripTerminalEscapes(s: string): string {
  return s
    .replace(CSI_PATTERN, '')
    .replace(OSC_PATTERN, '')
    .replace(FE_PATTERN, '')
    .replace(BARE_CONTROL_PATTERN, '');
}

export function normalizeClaudeOutput(raw: string): string {
  const trimmed = stripTerminalEscapes(raw).trim();
  if (trimmed.length === 0) return '';
  // `trimmed` is non-empty, so at least one split segment has non-whitespace
  // content; the `find` call returns that segment rather than undefined.
  const line = trimmed.split('\n').find((l) => l.trim().length > 0)!.trim();
  return line.length > MAX_LENGTH ? line.slice(0, MAX_LENGTH) : line;
}
