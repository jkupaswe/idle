import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// -----------------------------------------------------------------------------
// Hoisted mock seams
// -----------------------------------------------------------------------------
//
// UNIT tests drive the `execFileMock`. INTEGRATION tests flip
// `passthrough.enabled = true` so the mock factory delegates to the real
// `node:child_process.execFile` against `tests/fixtures/fake-claude-p.mjs`.
// Keeping one file with both describe blocks matches the design doc §7c and
// mirrors the mock wiring established in `tests/core/notify.test.ts`.
// -----------------------------------------------------------------------------

const { execFileMock, passthrough } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  passthrough: { enabled: false },
}));

vi.mock('node:child_process', async () => {
  const actual =
    await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    );
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: string[],
      optionsOrCb: unknown,
      maybeCb?: unknown,
    ) => {
      // Normalize the (options, cb) vs (cb) overload. invoke-claude-p.ts
      // always passes options, but we keep both shapes working so the
      // mock is an honest stand-in.
      let options: Record<string, unknown>;
      let callback: (
        err: Error | null,
        out: { stdout: string; stderr: string },
      ) => void;
      if (typeof optionsOrCb === 'function') {
        callback = optionsOrCb as typeof callback;
        options = {};
      } else {
        options = (optionsOrCb as Record<string, unknown>) ?? {};
        callback = maybeCb as typeof callback;
      }

      if (passthrough.enabled) {
        // Real execFile. Node's callback signature is (err, stdout, stderr)
        // — three args — but `invoke-claude-p.ts` goes through
        // `util.promisify`, which in our mocked module lacks the custom
        // `util.promisify.custom` symbol from the real execFile. So the
        // production code receives our callback shape `(err, {stdout, stderr})`.
        // Rewrap to preserve that contract.
        return (actual.execFile as unknown as (
          cmd: string,
          args: readonly string[],
          options: Record<string, unknown>,
          cb: (
            err: (Error & { stdout?: string; stderr?: string }) | null,
            stdout: string | Buffer,
            stderr: string | Buffer,
          ) => void,
        ) => import('node:child_process').ChildProcess)(
          cmd,
          args,
          options,
          (err, stdout, stderr) => {
            const out = typeof stdout === 'string' ? stdout : stdout?.toString('utf8') ?? '';
            const errOut =
              typeof stderr === 'string' ? stderr : stderr?.toString('utf8') ?? '';
            if (err) {
              // execFile attaches captured stdout/stderr on the error when
              // the child exits non-zero. Preserve them on the err object
              // so invoke-claude-p's categorizer can log stderr at debug.
              if (err.stderr === undefined) err.stderr = errOut;
              callback(err, { stdout: out, stderr: errOut });
            } else {
              callback(null, { stdout: out, stderr: errOut });
            }
          },
        );
      }

      // Mocked behavior — mirror the callback-form contract of
      // util.promisify(execFile).
      try {
        const result = execFileMock(cmd, args, options);
        if (result && typeof result.then === 'function') {
          result.then(
            (r: { stdout?: string; stderr?: string } | undefined) =>
              callback(null, {
                stdout: r?.stdout ?? '',
                stderr: r?.stderr ?? '',
              }),
            (err: Error) => callback(err, { stdout: '', stderr: '' }),
          );
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
      } catch (err) {
        callback(err as Error, { stdout: '', stderr: '' });
      }
      return undefined as unknown as import('node:child_process').ChildProcess;
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

let idleHome: string;

beforeEach(() => {
  execFileMock.mockReset();
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
// options, and error categorization.
// =============================================================================
describe('invokeClaudeP (UNIT — mocked child_process)', () => {
  test('calls execFile("claude", ["-p", prompt]) exactly', async () => {
    execFileMock.mockResolvedValue({ stdout: 'ok', stderr: '' });
    const res = await invokeClaudeP('take a walk');
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileMock.mock.calls[0]!;
    expect(cmd).toBe('claude');
    expect(args).toEqual(['-p', 'take a walk']);
    expect(res).toEqual({ ok: true, rawOutput: 'ok' });
  });

  test('options carry timeout / maxBuffer / env / windowsHide', async () => {
    execFileMock.mockResolvedValue({ stdout: '', stderr: '' });
    await invokeClaudeP('prompt');
    const [, , options] = execFileMock.mock.calls[0]!;
    expect(options.timeout).toBe(CLAUDE_P_TIMEOUT_MS);
    expect(CLAUDE_P_TIMEOUT_MS).toBe(8_000);
    expect(options.maxBuffer).toBe(CLAUDE_P_MAX_BUFFER);
    expect(options.windowsHide).toBe(true);
    expect(options.env).toBe(process.env);
  });

  test('does not inherit stdio', async () => {
    execFileMock.mockResolvedValue({ stdout: '', stderr: '' });
    await invokeClaudeP('prompt');
    const [, , options] = execFileMock.mock.calls[0]!;
    expect(options.stdio).toBeUndefined();
  });

  test('prompt with shell metacharacters is passed as a single argv entry', async () => {
    execFileMock.mockResolvedValue({ stdout: '', stderr: '' });
    const hostile = 'rm $(cat /tmp/x) `whoami` ; echo pwned';
    await invokeClaudeP(hostile);
    const [cmd, args] = execFileMock.mock.calls[0]!;
    expect(cmd).toBe('claude');
    expect(args).toEqual(['-p', hostile]);
    // No shell interpretation: the hostile string is argv[1] on the child,
    // not eval'd by a shell. execFile (not exec) guarantees this.
  });

  test('happy path maps stdout into rawOutput', async () => {
    execFileMock.mockResolvedValue({
      stdout: 'Go stretch.\n',
      stderr: '',
    });
    const res = await invokeClaudeP('p');
    expect(res).toEqual({ ok: true, rawOutput: 'Go stretch.\n' });
  });

  test('zero exit with stderr maps to ok; stderr logged at debug', async () => {
    execFileMock.mockResolvedValue({
      stdout: 'real output',
      stderr: 'DeprecationWarning: something',
    });
    const res = await invokeClaudeP('p');
    expect(res).toEqual({ ok: true, rawOutput: 'real output' });
  });

  test('nonzero exit maps to reason=nonzero', async () => {
    const err = Object.assign(new Error('cmd failed'), {
      code: 1,
      stderr: 'boom',
    });
    execFileMock.mockRejectedValue(err);
    const res = await invokeClaudeP('p');
    expect(res).toEqual({ ok: false, reason: 'nonzero' });
  });

  test('ENOENT maps to reason=enoent', async () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    execFileMock.mockRejectedValue(err);
    const res = await invokeClaudeP('p');
    expect(res).toEqual({ ok: false, reason: 'enoent' });
  });

  test('timeout (killed=true, signal=SIGTERM) maps to reason=timeout', async () => {
    const err = Object.assign(new Error('killed'), {
      killed: true,
      signal: 'SIGTERM',
    });
    execFileMock.mockRejectedValue(err);
    const res = await invokeClaudeP('p');
    expect(res).toEqual({ ok: false, reason: 'timeout' });
  });

  test('other-signal (killed=true, signal=SIGKILL) maps to reason=killed', async () => {
    const err = Object.assign(new Error('killed'), {
      killed: true,
      signal: 'SIGKILL',
    });
    execFileMock.mockRejectedValue(err);
    const res = await invokeClaudeP('p');
    expect(res).toEqual({ ok: false, reason: 'killed' });
  });

  test('uncategorized error maps to reason=nonzero (safe fallback)', async () => {
    // Plain Error with no code / killed / signal: treat as a generic failure
    // so the hook falls through to the silent body rather than crashing.
    execFileMock.mockRejectedValue(new Error('weird'));
    const res = await invokeClaudeP('p');
    expect(res).toEqual({ ok: false, reason: 'nonzero' });
  });
});

// =============================================================================
// INTEGRATION — real execFile against tests/fixtures/fake-claude-p.mjs. Slower,
// but validates real kernel/Node semantics that mocks can't fake (timeout
// SIGTERM, ENOENT shape, signal propagation).
// =============================================================================
describe('execClaudeLike (INTEGRATION — real execFile)', () => {
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
});
