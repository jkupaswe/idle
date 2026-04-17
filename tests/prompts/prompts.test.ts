import { describe, expect, test } from 'vitest';

import { buildPrompt as buildAbsurdist } from '../../src/prompts/absurdist.js';
import { buildPrompt as buildDry } from '../../src/prompts/dry.js';
import { buildPrompt as buildEarnest } from '../../src/prompts/earnest.js';
import { buildPrompt as buildSilent } from '../../src/prompts/silent.js';
import type { CheckInStats } from '../../src/lib/types.js';

const fullStats: CheckInStats = {
  duration_minutes: 47,
  tool_calls: 32,
  last_tool_name: 'Bash',
  last_tool_summary: 'git status',
};

const barestats: CheckInStats = {
  duration_minutes: 60,
  tool_calls: 50,
};

describe('silent preset', () => {
  test('returns bare stats, no LLM instructions', () => {
    expect(buildSilent(fullStats)).toBe('47m / 32 tool calls');
    expect(buildSilent(barestats)).toBe('60m / 50 tool calls');
  });
});

describe.each([
  ['dry', buildDry],
  ['earnest', buildEarnest],
  ['absurdist', buildAbsurdist],
])('%s preset', (name, build) => {
  test('includes duration and tool_calls', () => {
    const out = build(fullStats);
    expect(out).toContain('47');
    expect(out).toContain('32');
  });

  test('includes last tool name and summary when present', () => {
    const out = build(fullStats);
    expect(out).toContain('Bash');
    expect(out).toContain('git status');
  });

  test('omits last-tool line when both fields are absent', () => {
    const out = build(barestats);
    expect(out).not.toContain('last tool');
    expect(out).not.toContain('``');
  });

  test('caps the output at a single sentence max 30 words', () => {
    const out = build(fullStats);
    expect(out).toMatch(/Max 30 words\./i);
    expect(out).toMatch(/single-sentence/i);
    expect(out).toMatch(/return only the sentence/i);
  });

  test('forbids emoji and wellness-app tone', () => {
    const out = build(fullStats);
    expect(out).toMatch(/no emoji/i);
    expect(out).toMatch(/wellness-app/i);
  });

  test(`encodes the ${name} voice`, () => {
    const out = build(fullStats).toLowerCase();
    if (name === 'dry') {
      expect(out).toContain('dry');
      expect(out).toContain('unix-tool');
    } else if (name === 'earnest') {
      expect(out).toContain('direct');
      expect(out).toContain('warm');
    } else if (name === 'absurdist') {
      expect(out).toContain('deadpan');
      expect(out).toContain('absurdist');
    }
  });
});

describe('last-tool rendering', () => {
  test('renders name only when summary is absent', () => {
    const out = buildDry({
      duration_minutes: 10,
      tool_calls: 5,
      last_tool_name: 'Bash',
    });
    expect(out).toContain('`Bash`');
    expect(out).not.toContain('operating on');
  });
});
