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

  // ---- codex-review-2 finding 2: broader escape stripping ----

  test('OSC hyperlink (ESC ] 8 ; ; URL BEL ... BEL) is stripped', () => {
    const raw =
      '\x1b]8;;https://example.com\x07CLICK\x1b]8;;\x07';
    expect(normalizeClaudeOutput(raw)).toBe('CLICK');
  });

  test('OSC title-setter (ESC ] 0 ; title BEL) is stripped', () => {
    const raw = '\x1b]0;window title\x07hello';
    expect(normalizeClaudeOutput(raw)).toBe('hello');
  });

  test('OSC terminated with ESC backslash (string terminator) is stripped', () => {
    const raw = '\x1b]2;title\x1b\\after';
    expect(normalizeClaudeOutput(raw)).toBe('after');
  });

  test('bare BEL byte is stripped', () => {
    expect(normalizeClaudeOutput('hello\x07world')).toBe('helloworld');
  });

  test('CSI private-mode sequence with ? is stripped', () => {
    expect(normalizeClaudeOutput('\x1b[?25lhidden cursor\x1b[?25h')).toBe(
      'hidden cursor',
    );
  });

  test('Fe single-char escape (ESC M reverse line feed) is stripped', () => {
    expect(normalizeClaudeOutput('\x1bMreverse')).toBe('reverse');
  });

  test('plain text is unchanged (regression guard)', () => {
    expect(normalizeClaudeOutput('Go stretch.')).toBe('Go stretch.');
  });

  test('CSI + OSC + bare control chars combined', () => {
    const raw =
      '\x1b[31m\x1b]8;;https://x\x07click\x1b]8;;\x07\x1b[0m\x07Go.';
    expect(normalizeClaudeOutput(raw)).toBe('clickGo.');
  });
});
