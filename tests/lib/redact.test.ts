import { describe, expect, test } from 'vitest';

import { redactSecrets } from '../../src/lib/redact.js';

describe('redactSecrets', () => {
  test('redacts OpenAI sk-* keys that appear inside other text', () => {
    const input = '/tmp/openai-sk-abcdef1234567890abcdef/dump.txt';
    const out = redactSecrets(input);
    expect(out).not.toContain('sk-abcdef1234567890abcdef');
    expect(out).toContain('<redacted>');
  });

  test('redacts AWS access key id', () => {
    expect(redactSecrets('aws=AKIAIOSFODNN7EXAMPLE done')).toBe(
      'aws=<redacted> done',
    );
  });

  test('redacts GitHub personal access tokens', () => {
    expect(redactSecrets('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe('<redacted>');
    expect(redactSecrets('ghs_abcdefghijklmnopqrstuvwxyz')).toBe('<redacted>');
  });

  test('redacts Google API keys', () => {
    expect(
      redactSecrets('AIzaSyA-abcdefghijklmnopqrstuvwxyz12345'),
    ).toBe('<redacted>');
  });

  test('redacts Slack tokens', () => {
    expect(redactSecrets('xoxb-1234567890-abcdef')).toContain('<redacted>');
  });

  test('redacts Bearer tokens case-insensitively', () => {
    expect(redactSecrets('Authorization: Bearer abcdef1234567890abcdef')).toBe(
      'Authorization: Bearer <redacted>',
    );
    expect(redactSecrets('auth: bearer abcdef1234567890abcdef')).toMatch(
      /Bearer <redacted>/,
    );
  });

  test('redacts SHOUTY_CASE env-var secret assignments', () => {
    expect(redactSecrets('PASSWORD=hunter2')).toBe('PASSWORD=<redacted>');
    expect(redactSecrets('API_TOKEN=abcdef')).toBe('API_TOKEN=<redacted>');
    expect(redactSecrets('SESSION_COOKIE=xxxxx')).toBe(
      'SESSION_COOKIE=<redacted>',
    );
  });

  test('does not redact benign key=value pairs', () => {
    expect(redactSecrets('type=json')).toBe('type=json');
    expect(redactSecrets('file=app.ts')).toBe('file=app.ts');
  });

  test('preserves structure when nothing matches', () => {
    expect(redactSecrets('git status')).toBe('git status');
  });

  test('already-redacted input is a fixed point', () => {
    const once = redactSecrets('OPENAI_API_KEY=sk-abcdef1234567890abcdef');
    expect(redactSecrets(once)).toBe(once);
  });
});
