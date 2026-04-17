/**
 * Silent tone preset. No LLM call; Stop hook short-circuits when
 * `config.tone.preset === 'silent'` and passes this string straight to
 * `notify()`.
 *
 * Output format: `"<duration>m / <tool_calls> tool calls"`
 */

import type { CheckInStats } from '../lib/types.js';

export function buildPrompt(stats: CheckInStats): string {
  return `${stats.duration_minutes}m / ${stats.tool_calls} tool calls`;
}
