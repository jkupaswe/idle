import { describe, expect, test } from 'vitest';

import { normalizeClaudeOutput } from '../../src/hooks/normalize-claude-output.js';

describe('normalizeClaudeOutput', () => {
  test('empty string returns empty string', () => {
    expect(normalizeClaudeOutput('')).toBe('');
  });

  test('whitespace-only input returns empty string', () => {
    expect(normalizeClaudeOutput('   \n\n  \t  ')).toBe('');
  });

  test('ANSI-only input returns empty string', () => {
    expect(normalizeClaudeOutput('\x1b[31m\x1b[0m')).toBe('');
  });

  test('single line is trimmed', () => {
    expect(normalizeClaudeOutput('  Go stretch.  ')).toBe('Go stretch.');
  });

  test('multi-line input returns first non-empty line', () => {
    expect(normalizeClaudeOutput('\n\nGo stretch.\nSecond line.\n')).toBe(
      'Go stretch.',
    );
  });

  test('ANSI escape sequences are stripped mid-line', () => {
    expect(normalizeClaudeOutput('\x1b[31mgo\x1b[0m for a walk')).toBe(
      'go for a walk',
    );
  });

  test('ANSI + multi-line returns the first non-empty line without codes', () => {
    expect(normalizeClaudeOutput('\n\x1b[32mFirst.\x1b[0m\nSecond.')).toBe(
      'First.',
    );
  });

  test('exactly 200 characters passes through unchanged', () => {
    const exact = 'a'.repeat(200);
    expect(normalizeClaudeOutput(exact)).toBe(exact);
    expect(normalizeClaudeOutput(exact).length).toBe(200);
  });

  test('201 characters caps at 200', () => {
    const over = 'a'.repeat(201);
    const out = normalizeClaudeOutput(over);
    expect(out.length).toBe(200);
    expect(out).toBe('a'.repeat(200));
  });

  test('500 characters caps at 200', () => {
    const out = normalizeClaudeOutput('a'.repeat(500));
    expect(out.length).toBe(200);
  });

  test('ANSI + multi-line + long input combined', () => {
    const long = 'Z'.repeat(400);
    const raw = `\n\n\x1b[31m${long}\x1b[0m\nfallback line.\n`;
    const out = normalizeClaudeOutput(raw);
    expect(out.length).toBe(200);
    expect(out).toBe('Z'.repeat(200));
  });

  test('leading blank lines are skipped', () => {
    expect(normalizeClaudeOutput('\n\n\n  Hello.')).toBe('Hello.');
  });
});
