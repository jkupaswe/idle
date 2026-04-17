import type { CheckInStats } from '../lib/types.js';

/**
 * Render the "last tool" line for a prompt template. Omitted entirely
 * when the last-tool fields are absent — the hot path doesn't always
 * have them, and a blank backtick pair in the prompt reads worse than
 * no line at all.
 */
export function renderLastTool(stats: CheckInStats): string {
  const name = stats.last_tool_name;
  const summary = stats.last_tool_summary;
  if (name && summary) {
    return `The last tool was \`${name}\` operating on \`${summary}\`.`;
  }
  if (name) {
    return `The last tool was \`${name}\`.`;
  }
  return '';
}
