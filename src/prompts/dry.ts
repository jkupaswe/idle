/**
 * Dry tone preset. Matter-of-fact, occasionally observational.
 *
 * Example voice targets: "Forty minutes in. Stand up, look at something
 * more than ten feet away." No cheerfulness, no wellness-app language,
 * no hedging.
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
    'Write a single-sentence break suggestion in a dry, matter-of-fact voice.',
    'Think htop, fd, ripgrep — terse, unix-tool aesthetic. Occasionally observational.',
    'Never cheerful. Never preachy. No wellness-app language. No hedging. No emoji.',
    'Be specific to the work when it helps; otherwise keep it concrete and physical.',
    'Max 30 words. Return only the sentence. No preamble. No quotes.',
  ].join('\n');
}
