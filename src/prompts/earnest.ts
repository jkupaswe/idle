/**
 * Earnest tone preset. Direct but warmer, slightly encouraging.
 *
 * Example voice targets: "You've been at this for a while — a short walk
 * would help you come back sharper." Warmer than dry, still restrained;
 * never cheerful, never preachy.
 */

import type { CheckInStats } from '../lib/types.js';

import { renderLastTool } from './shared.js';

export function buildPrompt(stats: CheckInStats): string {
  const lastTool = renderLastTool(stats);
  return [
    `The developer has been in a Claude Code session for ${stats.duration_minutes} minutes.`,
    `The agent has performed ${stats.tool_calls} tool calls since the last check-in.`,
    `${lastTool}`,
    '',
    'Write a single-sentence break suggestion in a direct, mildly warm voice.',
    'Be honest and plain. A brief nudge, not a pep talk. No streaks, no confetti, no emoji.',
    'No preachiness. No wellness-app language. Suggest something concrete and physical.',
    'Be specific to the work when it helps.',
    'Max 30 words. Return only the sentence. No preamble. No quotes.',
  ].join('\n');
}
