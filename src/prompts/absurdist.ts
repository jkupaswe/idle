/**
 * Absurdist tone preset. Dry, with an oddly specific suggestion.
 *
 * Voice target: a single deadpan sentence whose punch comes from the
 * specificity of the suggestion, not from sentence count or delivery.
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
    'The suggestion must be concrete, physical, and oddly specific — the humor is the specificity, not the delivery.',
    'No punchline-chasing. No emoji. No wellness-app language. No hedging.',
    'Good shape: one sentence naming a specific, slightly strange action with a specific object. Example shape (do not copy): "Go arrange three unrelated objects on your desk in order of guilt."',
    'Max 30 words. Exactly one sentence. Return only the sentence. No preamble. No quotes.',
  ].join('\n');
}
