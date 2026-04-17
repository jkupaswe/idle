import { describe, expect, test } from 'vitest';

import {
  redactSecrets,
  summarizeToolInput,
} from '../../src/hooks/tool-summary.js';

describe('summarizeToolInput — allowlist extractors', () => {
  test('Bash extracts the first non-env-assignment token', () => {
    expect(summarizeToolInput('Bash', { command: 'git status' })).toBe('$ git');
    expect(summarizeToolInput('Bash', { command: '  npm run test --silent' })).toBe(
      '$ npm',
    );
  });

  test('Bash drops inline KEY=value env-var assignments', () => {
    expect(
      summarizeToolInput('Bash', { command: 'PASSWORD=supersecret ls /' }),
    ).toBe('$ ls');
    expect(
      summarizeToolInput('Bash', {
        command: 'AWS_ACCESS_KEY_ID=AKIA...  AWS_SECRET=... terraform apply',
      }),
    ).toBe('$ terraform');
  });

  test('Bash returns empty when command is missing or non-string', () => {
    expect(summarizeToolInput('Bash', {})).toBe('');
    expect(summarizeToolInput('Bash', { command: 123 })).toBe('');
  });

  test('Read/Write/Edit extract file_path only', () => {
    const path = '/Users/dev/project/src/app.ts';
    expect(summarizeToolInput('Read', { file_path: path })).toBe(path);
    expect(
      summarizeToolInput('Write', { file_path: path, content: 'OPENAI_API_KEY=sk-abcdef' }),
    ).toBe(path);
    expect(
      summarizeToolInput('Edit', {
        file_path: path,
        old_string: 'old token: sk-SECRETabcdef1234567890abcdef',
        new_string: 'new',
      }),
    ).toBe(path);
    expect(
      summarizeToolInput('MultiEdit', { file_path: path, edits: [] }),
    ).toBe(path);
  });

  test('Notebook extractors emit notebook_path only', () => {
    expect(
      summarizeToolInput('NotebookEdit', {
        notebook_path: '/x/nb.ipynb',
        new_source: 'secret',
      }),
    ).toBe('/x/nb.ipynb');
    expect(
      summarizeToolInput('NotebookRead', { notebook_path: '/x/nb.ipynb' }),
    ).toBe('/x/nb.ipynb');
  });

  test('Glob/Grep emit pattern only', () => {
    expect(summarizeToolInput('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts');
    expect(
      summarizeToolInput('Grep', { pattern: 'TODO', path: '/some/dir' }),
    ).toBe('TODO');
  });

  test('Task/Agent emit subagent_type, never prompt', () => {
    expect(
      summarizeToolInput('Task', {
        subagent_type: 'Explore',
        prompt: 'some secret plan with sk-abcdef1234567890abcdef',
      }),
    ).toBe('agent:Explore');
    expect(summarizeToolInput('Agent', {})).toBe('agent');
  });

  test('TodoWrite emits length only, never todo text', () => {
    expect(
      summarizeToolInput('TodoWrite', {
        todos: [
          { subject: 'rotate secret' },
          { subject: 'file ticket' },
          { subject: 'write a post-mortem about sk-abcdef12345678' },
        ],
      }),
    ).toBe('todos:3');
  });

  test('WebFetch/WebSearch/ToolSearch emit nothing', () => {
    expect(
      summarizeToolInput('WebFetch', {
        url: 'https://api.example.com/v1/x?api_key=supersecretTOKEN12345678',
      }),
    ).toBe('');
    expect(summarizeToolInput('WebSearch', { query: 'q' })).toBe('');
    expect(summarizeToolInput('ToolSearch', { query: 'q' })).toBe('');
  });

  test('unknown tool emits sorted keys only, never values', () => {
    const out = summarizeToolInput('MysteryTool', {
      alpha: 'secretA',
      gamma: 'secretB',
      beta: 'secretC',
    });
    expect(out).toBe('keys:alpha,beta,gamma');
    expect(out).not.toContain('secret');
  });

  test('non-object tool_input returns empty string', () => {
    expect(summarizeToolInput('Bash', null)).toBe('');
    expect(summarizeToolInput('Bash', undefined)).toBe('');
    expect(summarizeToolInput('Bash', ['ls'])).toBe('');
    expect(summarizeToolInput('Bash', 'ls')).toBe('');
  });

  test('pre-slices at 400 chars', () => {
    const huge = { file_path: '/' + 'a'.repeat(5_000) };
    expect(summarizeToolInput('Read', huge).length).toBe(400);
  });
});

describe('summarizeToolInput — secret redaction', () => {
  test('redacts OpenAI sk-* keys that appear in a file path', () => {
    const path = '/tmp/openai-sk-abcdef1234567890abcdef/dump.txt';
    const out = summarizeToolInput('Read', { file_path: path });
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
});
