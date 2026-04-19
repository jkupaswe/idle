import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { SessionEntry, SessionId } from '../../src/lib/types.js';
import { isSessionId } from '../../src/lib/types.js';

// -----------------------------------------------------------------------------
// Hoisted spies — one per seam the hook composes. Default implementations are
// restored in beforeEach so individual tests only need to override the spy
// they're exercising.
// -----------------------------------------------------------------------------
const {
  notifyMock,
  invokeClaudeMock,
  normalizeMock,
  dryMock,
  earnestMock,
  absurdistMock,
  silentMock,
  consumePendingMock,
} = vi.hoisted(() => ({
  notifyMock: vi.fn(),
  invokeClaudeMock: vi.fn(),
  normalizeMock: vi.fn(),
  dryMock: vi.fn(),
  earnestMock: vi.fn(),
  absurdistMock: vi.fn(),
  silentMock: vi.fn(),
  consumePendingMock: vi.fn(),
}));

vi.mock('../../src/core/notify.js', () => ({
  notify: (input: unknown) => notifyMock(input),
}));

vi.mock('../../src/hooks/invoke-claude-p.js', () => ({
  invokeClaudeP: (prompt: string) => invokeClaudeMock(prompt),
}));

vi.mock('../../src/hooks/normalize-claude-output.js', () => ({
  normalizeClaudeOutput: (raw: string) => normalizeMock(raw),
}));

vi.mock('../../src/prompts/dry.js', () => ({
  buildPrompt: (stats: unknown) => dryMock(stats),
}));
vi.mock('../../src/prompts/earnest.js', () => ({
  buildPrompt: (stats: unknown) => earnestMock(stats),
}));
vi.mock('../../src/prompts/absurdist.js', () => ({
  buildPrompt: (stats: unknown) => absurdistMock(stats),
}));
vi.mock('../../src/prompts/silent.js', () => ({
  buildPrompt: (stats: unknown) => silentMock(stats),
}));

vi.mock('../../src/core/state.js', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../../src/core/state.js');
  return {
    ...actual,
    consumePendingCheckin: (
      id: SessionId,
      options?: Parameters<typeof actual.consumePendingCheckin>[1],
    ) => consumePendingMock(id, options),
  };
});

// Real implementations for the seams we delegate to by default. Pulled once
// via `vi.importActual` because the mocks above replace the module exports
// for the rest of the file.
const realNormalize = (
  await vi.importActual<typeof import('../../src/hooks/normalize-claude-output.js')>(
    '../../src/hooks/normalize-claude-output.js',
  )
).normalizeClaudeOutput;
const realDry = (
  await vi.importActual<typeof import('../../src/prompts/dry.js')>(
    '../../src/prompts/dry.js',
  )
).buildPrompt;
const realEarnest = (
  await vi.importActual<typeof import('../../src/prompts/earnest.js')>(
    '../../src/prompts/earnest.js',
  )
).buildPrompt;
const realAbsurdist = (
  await vi.importActual<typeof import('../../src/prompts/absurdist.js')>(
    '../../src/prompts/absurdist.js',
  )
).buildPrompt;
const realSilent = (
  await vi.importActual<typeof import('../../src/prompts/silent.js')>(
    '../../src/prompts/silent.js',
  )
).buildPrompt;
const realState = await vi.importActual<typeof import('../../src/core/state.js')>(
  '../../src/core/state.js',
);

const { run: runStop } = await import('../../src/hooks/stop.js');
const { registerSession, readState } = await import('../../src/core/state.js');

// -----------------------------------------------------------------------------
// Shared setup
// -----------------------------------------------------------------------------

let home: string;

function asSessionId(raw: string): SessionId {
  if (!isSessionId(raw)) throw new Error(`invalid test session_id: ${raw}`);
  return raw;
}

function readDebugLog(): string {
  const path = join(home, 'debug.log');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function writeConfig(options: {
  preset?: 'dry' | 'earnest' | 'absurdist' | 'silent';
  method?: 'native' | 'terminal' | 'both';
  sound?: boolean;
}): void {
  const preset = options.preset ?? 'dry';
  const method = options.method ?? 'native';
  const sound = options.sound ?? false;
  writeFileSync(
    join(home, 'config.toml'),
    [
      '[thresholds]',
      'time_minutes = 45',
      'tool_calls = 40',
      '[tone]',
      `preset = "${preset}"`,
      '[notifications]',
      `method = "${method}"`,
      `sound = ${sound}`,
      '',
    ].join('\n'),
  );
}

async function seedSession(
  id: string,
  overrides: Partial<SessionEntry> = {},
): Promise<void> {
  const entry: SessionEntry = {
    started_at: new Date(Date.now() - 47 * 60_000).toISOString(),
    project_path: '/Users/dev/projects/example',
    tool_calls_since_checkin: 32,
    total_tool_calls: 100,
    last_checkin_at: null,
    checkins: [],
    ...overrides,
  };
  const result = await registerSession(asSessionId(id), entry);
  if (!result.ok) throw new Error(`seed failed: ${result.reason}`);
}

function stopPayload(
  fields: {
    session_id?: unknown;
    stop_hook_active?: boolean;
    transcript_path?: string;
    cwd?: string;
  } = {},
): string {
  return JSON.stringify({
    session_id: fields.session_id,
    transcript_path: fields.transcript_path ?? '/tmp/transcript.jsonl',
    cwd: fields.cwd ?? '/Users/dev/project',
    hook_event_name: 'Stop',
    ...(fields.stop_hook_active !== undefined
      ? { stop_hook_active: fields.stop_hook_active }
      : {}),
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'idle-stop-'));
  process.env.IDLE_HOME = home;

  notifyMock.mockReset();
  notifyMock.mockResolvedValue(undefined);
  invokeClaudeMock.mockReset();
  normalizeMock.mockReset();
  normalizeMock.mockImplementation(realNormalize);
  dryMock.mockReset();
  dryMock.mockImplementation(realDry);
  earnestMock.mockReset();
  earnestMock.mockImplementation(realEarnest);
  absurdistMock.mockReset();
  absurdistMock.mockImplementation(realAbsurdist);
  silentMock.mockReset();
  silentMock.mockImplementation(realSilent);
  consumePendingMock.mockReset();
  consumePendingMock.mockImplementation(realState.consumePendingCheckin);
});

afterEach(() => {
  delete process.env.IDLE_HOME;
  rmSync(home, { recursive: true, force: true });
});

// =============================================================================
// Guards and pre-consume flow
// =============================================================================
describe('stop hook: guards and pre-consume flow', () => {
  test('not_pending: valid stdin, no pending_checkin → exit 0, no notify', async () => {
    await seedSession('sess_abc123', { pending_checkin: false });
    const code = await runStop(stopPayload({ session_id: 'sess_abc123' }));
    expect(code).toBe(0);
    expect(notifyMock).not.toHaveBeenCalled();
    expect(invokeClaudeMock).not.toHaveBeenCalled();
  });

  test('invalid session_id: empty string → warn log, no consume, no notify', async () => {
    const code = await runStop(stopPayload({ session_id: '' }));
    expect(code).toBe(0);
    expect(consumePendingMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
    expect(readDebugLog()).toMatch(/"msg":"stop: invalid session_id"/);
  });

  test('stop_hook_active guard: true → exit 0, NO consume, NO notify', async () => {
    await seedSession('sess_abc123', { pending_checkin: true });
    const code = await runStop(
      stopPayload({ session_id: 'sess_abc123', stop_hook_active: true }),
    );
    expect(code).toBe(0);
    expect(consumePendingMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
    expect(readDebugLog()).toMatch(/"msg":"stop: re-entrant Stop, skipping"/);
    // Flag must still be set.
    const entry = readState().state.sessions['sess_abc123'];
    expect(entry?.pending_checkin).toBe(true);
  });

  test('consume not_found → debug log, no notify', async () => {
    const code = await runStop(stopPayload({ session_id: 'sess_unknown' }));
    expect(code).toBe(0);
    expect(notifyMock).not.toHaveBeenCalled();
    expect(readDebugLog()).toMatch(
      /"msg":"stop: consume skipped".*"reason":"not_found"/,
    );
  });

  test('consume disabled → debug log, no notify', async () => {
    await seedSession('sess_abc123', { pending_checkin: true, disabled: true });
    const code = await runStop(stopPayload({ session_id: 'sess_abc123' }));
    expect(code).toBe(0);
    expect(notifyMock).not.toHaveBeenCalled();
    expect(readDebugLog()).toMatch(
      /"msg":"stop: consume skipped".*"reason":"disabled"/,
    );
  });

  test('consume timeout → warn log, no notify', async () => {
    consumePendingMock.mockResolvedValue({ ok: false, reason: 'timeout' });
    const code = await runStop(stopPayload({ session_id: 'sess_abc123' }));
    expect(code).toBe(0);
    expect(notifyMock).not.toHaveBeenCalled();
    expect(readDebugLog()).toMatch(/"msg":"stop: consume timed out"/);
  });
});

// =============================================================================
// Malformed stdin
// =============================================================================
describe('stop hook: malformed stdin', () => {
  test.each([
    ['empty', ''],
    ['partial', '{ "session_id": "sess_a'],
    ['null', 'null'],
    ['true', 'true'],
    ['array', '[]'],
    ['number', '42'],
  ])('%s: exit 0, warn log, no consume, no notify', async (_label, payload) => {
    const code = await runStop(payload);
    expect(code).toBe(0);
    expect(consumePendingMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
    expect(readDebugLog()).toMatch(/"msg":"stop: stdin is not /);
  });
});

// =============================================================================
// Silent preset
// =============================================================================
describe('stop hook: silent preset', () => {
  test('short-circuits claude call; body = "<m>m / <n> tool calls"', async () => {
    writeConfig({ preset: 'silent' });
    invokeClaudeMock.mockImplementation(() => {
      throw new Error('invokeClaudeP should not be called for silent preset');
    });
    await seedSession('sess_abc123', {
      pending_checkin: true,
      started_at: new Date(Date.now() - 47 * 60_000).toISOString(),
      tool_calls_since_checkin: 32,
    });

    const code = await runStop(stopPayload({ session_id: 'sess_abc123' }));

    expect(code).toBe(0);
    expect(invokeClaudeMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const arg = notifyMock.mock.calls[0]![0] as { body: string; title: string };
    expect(arg.title).toBe('Idle');
    expect(arg.body).toBe('47m / 32 tool calls');
  });

  test('forwards sound=true', async () => {
    writeConfig({ preset: 'silent', sound: true });
    await seedSession('sess_abc123', { pending_checkin: true });
    await runStop(stopPayload({ session_id: 'sess_abc123' }));
    const arg = notifyMock.mock.calls[0]![0] as { sound: boolean };
    expect(arg.sound).toBe(true);
  });

  test('forwards method=terminal', async () => {
    writeConfig({ preset: 'silent', method: 'terminal' });
    await seedSession('sess_abc123', { pending_checkin: true });
    await runStop(stopPayload({ session_id: 'sess_abc123' }));
    const arg = notifyMock.mock.calls[0]![0] as { method: string };
    expect(arg.method).toBe('terminal');
  });
});

// =============================================================================
// Happy path — LLM-backed tones
// =============================================================================
describe('stop hook: happy path LLM', () => {
  test.each<'dry' | 'earnest' | 'absurdist'>(['dry', 'earnest', 'absurdist'])(
    '%s preset: invokes claude and normalizes output',
    async (preset) => {
      writeConfig({ preset });
      await seedSession('sess_abc123', { pending_checkin: true });
      invokeClaudeMock.mockResolvedValue({
        ok: true,
        rawOutput: 'Go stretch.\nSecond line.',
      });

      const code = await runStop(stopPayload({ session_id: 'sess_abc123' }));
      expect(code).toBe(0);
      expect(invokeClaudeMock).toHaveBeenCalledTimes(1);
      expect(notifyMock).toHaveBeenCalledTimes(1);
      const arg = notifyMock.mock.calls[0]![0] as { body: string; title: string };
      expect(arg.title).toBe('Idle');
      expect(arg.body).toBe('Go stretch.');
    },
  );

  test('forwards sound + method on LLM success', async () => {
    writeConfig({ preset: 'dry', sound: true, method: 'both' });
    await seedSession('sess_abc123', { pending_checkin: true });
    invokeClaudeMock.mockResolvedValue({ ok: true, rawOutput: 'Walk.' });

    await runStop(stopPayload({ session_id: 'sess_abc123' }));
    const arg = notifyMock.mock.calls[0]![0] as {
      body: string;
      sound: boolean;
      method: string;
    };
    expect(arg.body).toBe('Walk.');
    expect(arg.sound).toBe(true);
    expect(arg.method).toBe('both');
  });

  test('forwards sound + method on tier-2 fallback', async () => {
    writeConfig({ preset: 'dry', sound: true, method: 'terminal' });
    await seedSession('sess_abc123', { pending_checkin: true });
    invokeClaudeMock.mockResolvedValue({ ok: false, reason: 'timeout' });

    await runStop(stopPayload({ session_id: 'sess_abc123' }));
    const arg = notifyMock.mock.calls[0]![0] as {
      body: string;
      sound: boolean;
      method: string;
    };
    // Silent body format from the real silent prompt.
    expect(arg.body).toMatch(/^\d+m \/ \d+ tool calls$/);
    expect(arg.sound).toBe(true);
    expect(arg.method).toBe('terminal');
  });
});

// =============================================================================
// Tier-2 (known-failure) fallbacks
// =============================================================================
describe('stop hook: tier-2 (silent body) fallbacks', () => {
  test.each<'timeout' | 'enoent' | 'nonzero' | 'killed'>([
    'timeout',
    'enoent',
    'nonzero',
    'killed',
  ])('claude %s → silent body, debug log', async (reason) => {
    writeConfig({ preset: 'dry' });
    await seedSession('sess_abc123', { pending_checkin: true });
    invokeClaudeMock.mockResolvedValue({ ok: false, reason });

    await runStop(stopPayload({ session_id: 'sess_abc123' }));
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const arg = notifyMock.mock.calls[0]![0] as { body: string };
    expect(arg.body).toMatch(/^\d+m \/ \d+ tool calls$/);
    expect(readDebugLog()).toMatch(
      new RegExp(`"msg":"stop: claude invocation failed.*"reason":"${reason}"`),
    );
  });

  test('empty-after-normalize → silent body, debug log', async () => {
    writeConfig({ preset: 'dry' });
    await seedSession('sess_abc123', { pending_checkin: true });
    invokeClaudeMock.mockResolvedValue({
      ok: true,
      rawOutput: '   \n\n   ',
    });

    await runStop(stopPayload({ session_id: 'sess_abc123' }));
    const arg = notifyMock.mock.calls[0]![0] as { body: string };
    expect(arg.body).toMatch(/^\d+m \/ \d+ tool calls$/);
    expect(readDebugLog()).toMatch(
      /"msg":"stop: claude empty after normalize/,
    );
  });

  test('ConfigValidationError → defaults, still notifies', async () => {
    // Invalid TOML value — not a recognized preset.
    writeFileSync(
      join(home, 'config.toml'),
      [
        '[thresholds]',
        'time_minutes = 45',
        'tool_calls = 40',
        '[tone]',
        'preset = "nonsense"',
        '[notifications]',
        'method = "native"',
        'sound = false',
        '',
      ].join('\n'),
    );
    await seedSession('sess_abc123', { pending_checkin: true });
    invokeClaudeMock.mockResolvedValue({ ok: true, rawOutput: 'Walk.' });

    const code = await runStop(stopPayload({ session_id: 'sess_abc123' }));
    expect(code).toBe(0);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const arg = notifyMock.mock.calls[0]![0] as { body: string };
    expect(arg.body).toBe('Walk.');
    expect(readDebugLog()).toMatch(
      /"msg":"stop: config load failed, using defaults"/,
    );
  });
});

// =============================================================================
// Tier-3 (degraded) fallbacks — inner-catch paths
// =============================================================================
describe('stop hook: tier-3 degraded fallback (inner catch)', () => {
  test('invokeClaudeP throws → carries sound + method', async () => {
    writeConfig({ preset: 'dry', sound: true, method: 'both' });
    await seedSession('sess_abc123', { pending_checkin: true });
    invokeClaudeMock.mockRejectedValue(new Error('invoke blew up'));

    const code = await runStop(stopPayload({ session_id: 'sess_abc123' }));
    expect(code).toBe(0);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0]![0]).toEqual({
      title: 'Idle',
      body: 'Idle check-in',
      sound: true,
      method: 'both',
    });
    expect(readDebugLog()).toMatch(
      /"msg":"stop: post-consume unexpected throw".*"config_loaded":true/,
    );
  });

  test('normalizeClaudeOutput throws → carries method=terminal (no native popup)', async () => {
    writeConfig({ preset: 'dry', method: 'terminal' });
    await seedSession('sess_abc123', { pending_checkin: true });
    invokeClaudeMock.mockResolvedValue({ ok: true, rawOutput: 'x' });
    normalizeMock.mockImplementation(() => {
      throw new Error('normalize blew up');
    });

    await runStop(stopPayload({ session_id: 'sess_abc123' }));
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const arg = notifyMock.mock.calls[0]![0] as {
      body: string;
      method: string;
    };
    expect(arg.body).toBe('Idle check-in');
    expect(arg.method).toBe('terminal');
  });

  test('TEMPLATES.silent throws BEFORE silentBody exists → still carries method=terminal', async () => {
    // Proves config-derived opts flow into tier 3 even when `silentBody`
    // never got constructed. `TEMPLATES.silent(stats)` is the first call
    // that could throw after the notifOpts update, hitting the inner catch
    // before `silentBody` is assigned.
    writeConfig({ preset: 'dry', method: 'terminal' });
    await seedSession('sess_abc123', { pending_checkin: true });
    silentMock.mockImplementation(() => {
      throw new Error('silent template blew up');
    });

    await runStop(stopPayload({ session_id: 'sess_abc123' }));
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const arg = notifyMock.mock.calls[0]![0] as {
      body: string;
      method: string;
    };
    expect(arg.body).toBe('Idle check-in');
    expect(arg.method).toBe('terminal');
    // Should not have reached invokeClaudeP.
    expect(invokeClaudeMock).not.toHaveBeenCalled();
  });

  test('TEMPLATES[tone] throws → carries sound + method', async () => {
    writeConfig({ preset: 'dry', sound: true, method: 'both' });
    await seedSession('sess_abc123', { pending_checkin: true });
    dryMock.mockImplementation(() => {
      throw new Error('dry template blew up');
    });

    await runStop(stopPayload({ session_id: 'sess_abc123' }));
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0]![0]).toEqual({
      title: 'Idle',
      body: 'Idle check-in',
      sound: true,
      method: 'both',
    });
    expect(invokeClaudeMock).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Outer-catch: pre-consume unexpected throws must NOT notify and must NOT
// clear the pending flag.
// =============================================================================
describe('stop hook: outer catch (pre-consume)', () => {
  test('consumePendingCheckin itself throws → no notify, pending still set', async () => {
    writeConfig({ preset: 'dry' });
    await seedSession('sess_abc123', { pending_checkin: true });
    consumePendingMock.mockRejectedValue(new Error('state module blew up'));

    const code = await runStop(stopPayload({ session_id: 'sess_abc123' }));
    expect(code).toBe(0);
    expect(notifyMock).not.toHaveBeenCalled();
    expect(readDebugLog()).toMatch(
      /"msg":"stop: pre-consume unexpected throw"/,
    );
    // Pending flag must still be set since we never cleared it.
    const entry = readState().state.sessions['sess_abc123'];
    expect(entry?.pending_checkin).toBe(true);
  });
});

// =============================================================================
// Contracts
// =============================================================================
describe('stop hook: contracts', () => {
  test('never writes to stdout on the happy path', async () => {
    writeConfig({ preset: 'dry' });
    await seedSession('sess_abc123', { pending_checkin: true });
    invokeClaudeMock.mockResolvedValue({ ok: true, rawOutput: 'Walk.' });

    const original = process.stdout.write;
    const chunks: string[] = [];
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runStop(stopPayload({ session_id: 'sess_abc123' }));
    } finally {
      process.stdout.write = original;
    }
    expect(chunks.join('')).toBe('');
  });

  test('run() awaits notify before resolving', async () => {
    writeConfig({ preset: 'dry' });
    await seedSession('sess_abc123', { pending_checkin: true });
    invokeClaudeMock.mockResolvedValue({ ok: true, rawOutput: 'Walk.' });

    let releaseNotify: (() => void) | undefined;
    const notifyGate = new Promise<void>((resolve) => {
      releaseNotify = resolve;
    });
    notifyMock.mockImplementation(() => notifyGate);

    let runResolved = false;
    const runPromise = runStop(stopPayload({ session_id: 'sess_abc123' })).then(
      (code) => {
        runResolved = true;
        return code;
      },
    );

    // Wait for `run()` to reach `await notify(...)`. The pre-notify path
    // involves a real file lock for `consumePendingCheckin`, so poll instead
    // of a fixed sleep.
    for (let i = 0; i < 100; i++) {
      if (notifyMock.mock.calls.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(runResolved).toBe(false);

    releaseNotify!();
    await runPromise;
    expect(runResolved).toBe(true);
  });
});
