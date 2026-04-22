import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ChildProcess } from 'node:child_process';

// -----------------------------------------------------------------------------
// Hoisted mock seams
// -----------------------------------------------------------------------------
//
// UNIT tests drive the `spawnMock`. INTEGRATION tests flip
// `passthrough.enabled = true` so the mock factory delegates to the real
// `node:child_process.spawn` against `tests/fixtures/fake-claude-p.mjs`.
// Keeping one file with both describe blocks matches the design doc §7c and
// mirrors the mock wiring established in `tests/core/notify.test.ts`.
//
// F-012: the helper uses `spawn` (not `execFile`) so we can pin
// `stdio: ['ignore', 'pipe', 'pipe']`. The `'ignore'` on stdin prevents
// `claude -p` from blocking on a read of an inherited pipe.
// -----------------------------------------------------------------------------

const { spawnMock, passthrough } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  passthrough: { enabled: false },
}));

vi.mock('node:child_process', async () => {
  const actual =
    await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    );
  return {
    ...actual,
    spawn: (
      cmd: string,
      args: readonly string[],
      options?: Record<string, unknown>,
    ) => {
      if (passthrough.enabled) {
        return (actual.spawn as unknown as (
          cmd: string,
          args: readonly string[],
          options?: Record<string, unknown>,
        ) => ChildProcess)(cmd, args, options);
      }
      return spawnMock(cmd, args, options ?? {});
    },
  };
});

const {
  CLAUDE_P_MAX_BUFFER,
  CLAUDE_P_TIMEOUT_MS,
  execClaudeLike,
  invokeClaudeP,
} = await import('../../src/hooks/invoke-claude-p.js');

const FIXTURE_PATH = fileURLToPath(
  new URL('../fixtures/fake-claude-p.mjs', import.meta.url),
);

// -----------------------------------------------------------------------------
// Fake ChildProcess helpers for UNIT tests
// -----------------------------------------------------------------------------

interface FakeChild {
  child: ChildProcess;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const kill = vi.fn().mockReturnValue(true);
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, {
    stdout,
    stderr,
    kill,
  }) as unknown as ChildProcess;
  return { child, stdout, stderr, kill };
}

function emitClose(
  child: ChildProcess,
  code: number | null,
  signal: NodeJS.Signals | null,
): void {
  (child as unknown as EventEmitter).emit('close', code, signal);
}

function emitError(child: ChildProcess, err: NodeJS.ErrnoException): void {
  (child as unknown as EventEmitter).emit('error', err);
}

let idleHome: string;

beforeEach(() => {
  spawnMock.mockReset();
  passthrough.enabled = false;
  idleHome = mkdtempSync(join(tmpdir(), 'idle-invoke-claude-'));
  process.env.IDLE_HOME = idleHome;
});

afterEach(() => {
  delete process.env.IDLE_HOME;
  rmSync(idleHome, { recursive: true, force: true });
});

// =============================================================================
// UNIT — node:child_process is mocked. Fast-feedback coverage of argv shape,
// options, and exit categorization.
// =============================================================================
describe('invokeClaudeP (UNIT — mocked child_process)', () => {
  test('calls spawn("claude", ["-p", prompt]) exactly', async () => {
    const { child } = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = invokeClaudeP('take a walk');
    emitClose(child, 0, null);
    const res = await p;
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0]!;
    expect(cmd).toBe('claude');
    expect(args).toEqual(['-p', 'take a walk']);
    expect(res).toEqual({ ok: true, rawOutput: '' });
  });

  test('options carry env / windowsHide', async () => {
    const { child } = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = invokeClaudeP('prompt');
    emitClose(child, 0, null);
    await p;
    const [, , options] = spawnMock.mock.calls[0]!;
    expect(options.env).toBe(process.env);
    expect(options.windowsHide).toBe(true);
  });

  test('stdio is ["ignore", "pipe", "pipe"] (F-012)', async () => {
    // Load-bearing: `'ignore'` on stdin gives the child immediate EOF, so
    // `claude -p` does not block reading from an inherited pipe. Any drift
    // here re-opens F-012 (exit 143 / SIGTERM before notification).
    const { child } = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = invokeClaudeP('prompt');
    emitClose(child, 0, null);
    await p;
    const [, , options] = spawnMock.mock.calls[0]!;
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  test('production timeout is 8s', () => {
    expect(CLAUDE_P_TIMEOUT_MS).toBe(8_000);
  });

  test('max buffer is 64KB', () => {
    expect(CLAUDE_P_MAX_BUFFER).toBe(64 * 1024);
  });

  test('prompt with shell metacharacters is passed as a single argv entry', async () => {
    const { child } = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const hostile = 'rm $(cat /tmp/x) `whoami` ; echo pwned';
    const p = invokeClaudeP(hostile);
    emitClose(child, 0, null);
    await p;
    const [cmd, args] = spawnMock.mock.calls[0]!;
    expect(cmd).toBe('claude');
    expect(args).toEqual(['-p', hostile]);
    // No shell interpretation: the hostile string is argv[1] on the child,
    // not eval'd by a shell. spawn without `shell: true` guarantees this.
  });

  test('happy path maps stdout into rawOutput', async () => {
    const { child, stdout } = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = invokeClaudeP('p');
    stdout.emit('data', Buffer.from('Go stretch.\n'));
    emitClose(child, 0, null);
    const res = await p;
    expect(res).toEqual({ ok: true, rawOutput: 'Go stretch.\n' });
  });

  test('multi-chunk stdout is concatenated', async () => {
    const { child, stdout } = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = invokeClaudeP('p');
    stdout.emit('data', Buffer.from('Go '));
    stdout.emit('data', Buffer.from('stretch.'));
    emitClose(child, 0, null);
    const res = await p;
    expect(res).toEqual({ ok: true, rawOutput: 'Go stretch.' });
  });

  test('zero exit with stderr maps to ok; stderr logged at debug', async () => {
    const { child, stdout, stderr } = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = invokeClaudeP('p');
    stdout.emit('data', Buffer.from('real output'));
    stderr.emit('data', Buffer.from('DeprecationWarning: something'));
    emitClose(child, 0, null);
    const res = await p;
    expect(res).toEqual({ ok: true, rawOutput: 'real output' });
  });

  test('nonzero exit maps to reason=nonzero', async () => {
    const { child, stderr } = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = invokeClaudeP('p');
    stderr.emit('data', Buffer.from('boom'));
    emitClose(child, 1, null);
    const res = await p;
    expect(res).toEqual({ ok: false, reason: 'nonzero' });
  });

  test('ENOENT via error event maps to reason=enoent', async () => {
    const { child } = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = invokeClaudeP('p');
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    emitError(child, err);
    const res = await p;
    expect(res).toEqual({ ok: false, reason: 'enoent' });
  });

  test('ENOENT via synchronous spawn throw maps to reason=enoent', async () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    spawnMock.mockImplementationOnce(() => {
      throw err;
    });
    const res = await invokeClaudeP('p');
    expect(res).toEqual({ ok: false, reason: 'enoent' });
  });

  test('non-ENOENT error event maps to reason=nonzero (uncategorized fallback)', async () => {
    const { child } = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = invokeClaudeP('p');
    const err = Object.assign(new Error('weird'), { code: 'EACCES' });
    emitError(child, err);
    const res = await p;
    expect(res).toEqual({ ok: false, reason: 'nonzero' });
  });

  test('external SIGTERM (not timeout) maps to reason=killed', async () => {
    // Our internal timeout did not fire — `timedOut` stays false. A signal
    // arriving from elsewhere is `killed`, not `timeout`. (Inherited from
    // codex-review-2 finding 3: foreign SIGTERMs must not be misreported
    // as our own timeout.)
    const { child } = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = invokeClaudeP('p');
    emitClose(child, null, 'SIGTERM');
    const res = await p;
    expect(res).toEqual({ ok: false, reason: 'killed' });
  });

  test('external SIGKILL maps to reason=killed', async () => {
    const { child } = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = invokeClaudeP('p');
    emitClose(child, null, 'SIGKILL');
    const res = await p;
    expect(res).toEqual({ ok: false, reason: 'killed' });
  });

  test('our timeout fires: kill() called with SIGTERM, result is reason=timeout', async () => {
    // Drive our internal setTimeout deterministically. Caller passes a tiny
    // timeoutMs via `execClaudeLike`; the close event follows the kill.
    const { child, kill } = makeFakeChild();
    spawnMock.mockReturnValueOnce(child);
    kill.mockImplementation((signal: NodeJS.Signals) => {
      // Simulate the child exiting in response to the SIGTERM we sent.
      setImmediate(() => emitClose(child, null, signal));
      return true;
    });
    const res = await execClaudeLike('claude', ['-p', 'x'], 10);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(res).toEqual({ ok: false, reason: 'timeout' });
  });
});

// =============================================================================
// INTEGRATION — real spawn against tests/fixtures/fake-claude-p.mjs. Slower,
// but validates real kernel/Node semantics that mocks can't fake (timeout
// SIGTERM, ENOENT shape, signal propagation, stdio=['ignore', ...] giving
// the child immediate EOF).
// =============================================================================
describe('execClaudeLike (INTEGRATION — real spawn)', () => {
  beforeEach(() => {
    passthrough.enabled = true;
  });

  test('happy path: stdout captured', async () => {
    const res = await execClaudeLike(
      process.execPath,
      [FIXTURE_PATH, '--stdout', 'Go stretch.\\n', '--exit', '0'],
      2_000,
    );
    expect(res).toEqual({ ok: true, rawOutput: 'Go stretch.\n' });
  });

  test('timeout: fixture sleeps past the budget → reason=timeout', async () => {
    const res = await execClaudeLike(
      process.execPath,
      [FIXTURE_PATH, '--stdout', 'late', '--sleep-ms', '3000'],
      500,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('timeout');
  });

  test('ENOENT: missing binary → reason=enoent', async () => {
    const res = await execClaudeLike(
      '/definitely/not/a/binary-that-exists-xyz',
      [],
      2_000,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('enoent');
  });

  test('non-zero exit → reason=nonzero; stderr observable in debug log', async () => {
    const res = await execClaudeLike(
      process.execPath,
      [FIXTURE_PATH, '--stderr', 'boom', '--exit', '1'],
      2_000,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('nonzero');
  });

  test('stderr with zero exit → reason=ok; stdout still returned', async () => {
    const res = await execClaudeLike(
      process.execPath,
      [
        FIXTURE_PATH,
        '--stdout',
        'ok',
        '--stderr',
        'DeprecationWarning',
        '--exit',
        '0',
      ],
      2_000,
    );
    expect(res).toEqual({ ok: true, rawOutput: 'ok' });
  });

  test('killed signal: fixture self-SIGKILL → reason=killed', async () => {
    const res = await execClaudeLike(
      process.execPath,
      [
        FIXTURE_PATH,
        '--self-kill-after-ms',
        '100',
        '--sleep-ms',
        '2000',
      ],
      5_000,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('killed');
  });

  test('self-SIGTERM is not misclassified as timeout (codex-review-2 finding 3)', async () => {
    // Fixture sends SIGTERM to itself well before the execClaudeLike
    // deadline. If the helper looked only at `signal === 'SIGTERM'` it
    // would call this a timeout; the real answer is `killed` because our
    // internal setTimeout never fired.
    const res = await execClaudeLike(
      process.execPath,
      [
        FIXTURE_PATH,
        '--self-kill-after-ms',
        '100',
        '--self-signal',
        'SIGTERM',
        '--sleep-ms',
        '2000',
      ],
      5_000,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('killed');
  });
});
