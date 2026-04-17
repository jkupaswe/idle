import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { run as runPostToolUse } from '../../src/hooks/post-tool-use.js';
import { readState, registerSession } from '../../src/core/state.js';
import type { SessionEntry, SessionId } from '../../src/lib/types.js';
import { isSessionId } from '../../src/lib/types.js';

let home: string;
const FIX = join(__dirname, '..', 'fixtures');

function asSessionId(raw: string): SessionId {
  if (!isSessionId(raw)) throw new Error(`invalid test session_id: ${raw}`);
  return raw;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'idle-posttooluse-'));
  process.env.IDLE_HOME = home;
});

afterEach(() => {
  delete process.env.IDLE_HOME;
  rmSync(home, { recursive: true, force: true });
});

function fixture(name: string): string {
  return readFileSync(join(FIX, name), 'utf8');
}

function readDebugLog(): string {
  const path = join(home, 'debug.log');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

async function seedSession(
  id: string,
  overrides: Partial<SessionEntry> = {},
): Promise<void> {
  const entry: SessionEntry = {
    started_at: new Date().toISOString(),
    project_path: '/Users/dev/projects/example',
    tool_calls_since_checkin: 0,
    total_tool_calls: 0,
    last_checkin_at: null,
    checkins: [],
    ...overrides,
  };
  const result = await registerSession(asSessionId(id), entry);
  if (!result.ok) throw new Error(`seed failed: ${result.reason}`);
}

describe('post-tool-use hook', () => {
  test('valid payload increments counters for a known session', async () => {
    await seedSession('sess_abc123');

    const code = await runPostToolUse(fixture('post-tool-use-bash.json'));
    expect(code).toBe(0);

    const state = readState().state;
    const entry = state.sessions['sess_abc123'];
    expect(entry).toBeDefined();
    expect(entry!.tool_calls_since_checkin).toBe(1);
    expect(entry!.total_tool_calls).toBe(1);
    expect(entry!.last_tool_name).toBe('Bash');
    // Hook uses allowlist extraction, not raw JSON stringification: for
    // Bash we emit "$ <first-non-env-assignment-token>", never the args.
    expect(entry!.last_tool_summary).toBe('$ ls');
    expect(entry!.pending_checkin).toBeUndefined();
  });

  test('Bash secrets in command args never reach state or archive', async () => {
    await seedSession('sess_abc123');
    const payload = JSON.stringify({
      session_id: 'sess_abc123',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: {
        command:
          'curl -H "Authorization: Bearer sk-abcdef1234567890abcdef" ' +
          'https://api.openai.com/v1/chat ' +
          'OPENAI_API_KEY=sk-leakedSECRETabcdef1234567890',
      },
    });
    await runPostToolUse(payload);
    const entry = readState().state.sessions['sess_abc123']!;
    expect(entry.last_tool_summary).toBe('$ curl');
    expect(entry.last_tool_summary).not.toContain('sk-abcdef');
    expect(entry.last_tool_summary).not.toContain('Bearer');
    expect(entry.last_tool_summary).not.toContain('OPENAI_API_KEY');
  });

  test('Edit old_string/new_string content is never summarized', async () => {
    await seedSession('sess_abc123');
    const payload = JSON.stringify({
      session_id: 'sess_abc123',
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: {
        file_path: '/Users/dev/project/src/auth.ts',
        old_string: 'const API_KEY = "sk-SECRETabcdef1234567890abcdef";',
        new_string: 'const API_KEY = process.env.API_KEY;',
      },
    });
    await runPostToolUse(payload);
    const entry = readState().state.sessions['sess_abc123']!;
    expect(entry.last_tool_summary).toBe('/Users/dev/project/src/auth.ts');
    expect(entry.last_tool_summary).not.toContain('sk-SECRET');
    expect(entry.last_tool_summary).not.toContain('API_KEY');
  });

  test('Write.content is never persisted, only the file path', async () => {
    await seedSession('sess_abc123');
    const payload = JSON.stringify({
      session_id: 'sess_abc123',
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: {
        file_path: '/tmp/notes.md',
        content:
          'TODO: rotate AWS creds. Current: AKIAIOSFODNN7EXAMPLE, Bearer abcdef1234567890abcdef',
      },
    });
    await runPostToolUse(payload);
    const entry = readState().state.sessions['sess_abc123']!;
    expect(entry.last_tool_summary).toBe('/tmp/notes.md');
    expect(entry.last_tool_summary).not.toContain('AKIA');
  });

  test('unknown tool produces keys-only, never values', async () => {
    await seedSession('sess_abc123');
    const payload = JSON.stringify({
      session_id: 'sess_abc123',
      hook_event_name: 'PostToolUse',
      tool_name: 'MysteryTool',
      tool_input: { secret_key: 'sk-leakeabcdef1234567890abcdef', normal: 'ok' },
    });
    await runPostToolUse(payload);
    const entry = readState().state.sessions['sess_abc123']!;
    expect(entry.last_tool_summary).toBe('keys:normal,secret_key');
    expect(entry.last_tool_summary).not.toContain('sk-');
    expect(entry.last_tool_summary).not.toContain('leaked');
  });

  test('does not write to stdout', async () => {
    await seedSession('sess_abc123');
    const original = process.stdout.write;
    const chunks: string[] = [];
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runPostToolUse(fixture('post-tool-use-bash.json'));
    } finally {
      process.stdout.write = original;
    }
    expect(chunks.join('')).toBe('');
  });

  test('exits 0 on invalid JSON', async () => {
    const code = await runPostToolUse('{ malformed');
    expect(code).toBe(0);
    expect(readDebugLog()).toMatch(
      /"msg":"post-tool-use: stdin is not valid JSON"/,
    );
  });

  test('exits 0 when session_id is missing or invalid', async () => {
    const code = await runPostToolUse(
      JSON.stringify({ tool_name: 'Bash', tool_input: {} }),
    );
    expect(code).toBe(0);
    expect(readState().state.sessions).toEqual({});
    expect(readDebugLog()).toMatch(/"msg":"post-tool-use: invalid session_id"/);
  });

  test('exits 0 when tool_name is missing', async () => {
    await seedSession('sess_abc123');
    const code = await runPostToolUse(
      fixture('post-tool-use-missing-tool-name.json'),
    );
    expect(code).toBe(0);
    const entry = readState().state.sessions['sess_abc123'];
    expect(entry?.total_tool_calls).toBe(0);
    expect(readDebugLog()).toMatch(/"msg":"post-tool-use: invalid tool_name"/);
  });

  test('unknown session_id logs debug and does not throw', async () => {
    const code = await runPostToolUse(
      fixture('post-tool-use-unknown-session.json'),
    );
    expect(code).toBe(0);
    expect(readState().state.sessions).toEqual({});
    expect(readDebugLog()).toMatch(
      /"msg":"post-tool-use: increment skipped".*"reason":"not_found"/,
    );
  });

  test('disabled session short-circuits inside the helper', async () => {
    await seedSession('sess_abc123', { disabled: true });
    const code = await runPostToolUse(fixture('post-tool-use-bash.json'));
    expect(code).toBe(0);
    const entry = readState().state.sessions['sess_abc123'];
    expect(entry?.total_tool_calls).toBe(0);
    expect(readDebugLog()).toMatch(
      /"msg":"post-tool-use: increment skipped".*"reason":"disabled"/,
    );
  });

  test('state helper caps last_tool_summary at 200 characters', async () => {
    await seedSession('sess_abc123');
    // Long file_path goes through the safe extractor; state.ts truncates to 200.
    const longPath = '/' + 'a'.repeat(5_000);
    const payload = JSON.stringify({
      session_id: 'sess_abc123',
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: longPath },
    });
    await runPostToolUse(payload);
    const entry = readState().state.sessions['sess_abc123'];
    expect(entry?.last_tool_summary?.length).toBe(200);
  });

  test('threshold tripped sets pending_checkin when tool_calls threshold is 1', async () => {
    // Config has tool_calls threshold = 1 so the first call trips.
    writeFileSync(
      join(home, 'config.toml'),
      [
        '[thresholds]',
        'time_minutes = 0',
        'tool_calls = 1',
        '[tone]',
        'preset = "dry"',
        '[notifications]',
        'method = "native"',
        'sound = false',
        '',
      ].join('\n'),
    );
    await seedSession('sess_abc123');
    await runPostToolUse(fixture('post-tool-use-bash.json'));
    const entry = readState().state.sessions['sess_abc123'];
    expect(entry?.pending_checkin).toBe(true);
    expect(readDebugLog()).toMatch(
      /"msg":"post-tool-use: threshold tripped"/,
    );
  });

  test('broken config falls back to defaults and still increments', async () => {
    writeFileSync(join(home, 'config.toml'), 'this =is n0t toml =');
    await seedSession('sess_abc123');
    const code = await runPostToolUse(fixture('post-tool-use-bash.json'));
    expect(code).toBe(0);
    const entry = readState().state.sessions['sess_abc123'];
    expect(entry?.total_tool_calls).toBe(1);
    expect(readDebugLog()).toMatch(
      /"msg":"post-tool-use: config load failed, using defaults"/,
    );
  });

});
