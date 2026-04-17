/**
 * Absurdist tone preset. Dry, with an oddly specific suggestion.
 *
 * Example voice targets: "Go put three unrelated objects in a line on
 * your desk. Come back." Deadpan. The suggestion is the joke; the voice
 * delivering it is flat.
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
    'Write a single-sentence break suggestion in a deadpan, mildly absurdist voice.',
    'The suggestion should be concrete, physical, and oddly specific — the joke is the specificity, not the delivery.',
    'No punchline-chasing. No emoji. No wellness-app language. No hedging.',
    'Good shape: "Go [specific weird action with specific object]. Come back."',
    'Max 30 words. Return only the sentence. No preamble. No quotes.',
  ].join('\n');
}
