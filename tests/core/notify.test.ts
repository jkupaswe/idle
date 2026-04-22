import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Mock execFile so no real notifier runs. The promisified form of execFile
// is what the module uses; we mirror that shape here.
const execFileMock = vi.hoisted(() => vi.fn());

// Mock the three `node:fs` calls used by the terminal-write path (F-014).
// Keep every other `node:fs` export intact for other modules (log.ts uses
// appendFileSync/mkdirSync). Default behavior is set in beforeEach:
// `openSync('/dev/tty')` throws ENOENT so the stderr-fallback branch runs
// for all legacy tests. Individual tests override for the /dev/tty-success
// path.
const fsMock = vi.hoisted(() => ({
  openSync: vi.fn(),
  writeSync: vi.fn(),
  closeSync: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    openSync: fsMock.openSync,
    writeSync: fsMock.writeSync,
    closeSync: fsMock.closeSync,
  };
});

vi.mock('node:child_process', () => ({
  // Support both `execFile(cmd, args, cb)` and
  // `execFile(cmd, args, options, cb)` — the latter is used after Decision RR
  // (2s timeouts on every native subprocess call). When the caller passes a
  // `timeout`, the mock honors it with an internal timer so tests can
  // simulate a wedged osascript / notify-send / which.
  execFile: (
    cmd: string,
    args: string[],
    optionsOrCb: unknown,
    maybeCb?: unknown,
  ) => {
    let options: { timeout?: number };
    let cb: (
      err: Error | null,
      out: { stdout: string; stderr: string },
    ) => void;
    if (typeof optionsOrCb === 'function') {
      options = {};
      cb = optionsOrCb as typeof cb;
    } else {
      options = (optionsOrCb as { timeout?: number }) ?? {};
      cb = maybeCb as typeof cb;
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (
      err: Error | null,
      out: { stdout: string; stderr: string },
    ) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      cb(err, out);
    };

    if (typeof options.timeout === 'number' && options.timeout > 0) {
      timer = setTimeout(() => {
        const err = Object.assign(new Error('Command timed out'), {
          killed: true,
          signal: 'SIGTERM',
        });
        settle(err, { stdout: '', stderr: '' });
      }, options.timeout);
    }

    try {
      const result = execFileMock(cmd, args);
      if (result && typeof result.then === 'function') {
        result.then(
          (r: { stdout?: string; stderr?: string } | undefined) =>
            settle(null, {
              stdout: r?.stdout ?? '',
              stderr: r?.stderr ?? '',
            }),
          (err: Error) => settle(err, { stdout: '', stderr: '' }),
        );
      } else {
        settle(null, { stdout: '', stderr: '' });
      }
    } catch (err) {
      settle(err as Error, { stdout: '', stderr: '' });
    }
  },
}));

const {
  buildMacAppleScript,
  escapeAppleScriptString,
  notify,
} = await import('../../src/core/notify.js');
import type { NotificationMethod } from '../../src/lib/types.js';

let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  execFileMock.mockReset();
  fsMock.openSync.mockReset();
  fsMock.writeSync.mockReset();
  fsMock.closeSync.mockReset();
  // Default: no controlling TTY available. writeTerminal falls through to
  // stderr so existing tests that assert on `stderrSpy` keep working.
  fsMock.openSync.mockImplementation(() => {
    const err = new Error(
      "ENOENT: no such file or directory, open '/dev/tty'",
    ) as Error & { code?: string };
    err.code = 'ENOENT';
    throw err;
  });
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  delete process.env.IDLE_NOTIFY_PLATFORM;
});

describe('escapeAppleScriptString', () => {
  test('escapes backslashes and double quotes', () => {
    expect(escapeAppleScriptString('a "b" c')).toBe('a \\"b\\" c');
    expect(escapeAppleScriptString('path\\to\\file')).toBe(
      'path\\\\to\\\\file',
    );
    expect(escapeAppleScriptString('plain')).toBe('plain');
  });

  test('escapes backslash before double quote so it survives round-trip', () => {
    expect(escapeAppleScriptString('a\\"b')).toBe('a\\\\\\"b');
  });
});

describe('buildMacAppleScript', () => {
  test('wraps body and title with display notification syntax', () => {
    const s = buildMacAppleScript({ title: 'Idle', body: '47m, 32 calls' });
    expect(s).toBe(
      'display notification "47m, 32 calls" with title "Idle"',
    );
  });

  test('appends sound name when sound is true', () => {
    const s = buildMacAppleScript({
      title: 'Idle',
      body: 'ping',
      sound: true,
    });
    expect(s).toContain('sound name "Ping"');
  });

  test('escapes quotes in both title and body', () => {
    const s = buildMacAppleScript({
      title: 'a"b',
      body: 'c"d',
    });
    expect(s).toBe(
      'display notification "c\\"d" with title "a\\"b"',
    );
  });
});

describe('notify (darwin)', () => {
  beforeEach(() => {
    process.env.IDLE_NOTIFY_PLATFORM = 'darwin';
  });

  test('invokes osascript with -e and a safely-escaped script', async () => {
    execFileMock.mockResolvedValue({ stdout: '', stderr: '' });
    await notify({ title: 'Idle', body: 'Look at something ten feet away.' });

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileMock.mock.calls[0]!;
    expect(cmd).toBe('osascript');
    expect(args[0]).toBe('-e');
    expect(args[1]).toBe(
      'display notification "Look at something ten feet away." with title "Idle"',
    );
  });

  test('escapes embedded quotes before handing to osascript', async () => {
    execFileMock.mockResolvedValue({ stdout: '', stderr: '' });
    await notify({ title: 'Idle', body: 'say "hi" please' });
    const [, args] = execFileMock.mock.calls[0]!;
    expect(args[1]).toBe(
      'display notification "say \\"hi\\" please" with title "Idle"',
    );
  });

  test('falls back to stderr if osascript fails', async () => {
    execFileMock.mockRejectedValue(new Error('osascript boom'));
    await notify({ title: 'Idle', body: 'body' });
    expect(stderrSpy).toHaveBeenCalledWith('Idle: body\n');
  });
});

describe('notify (linux)', () => {
  beforeEach(() => {
    process.env.IDLE_NOTIFY_PLATFORM = 'linux';
  });

  test('invokes notify-send with `--` separator and title/body as separate args', async () => {
    // First call: `which notify-send` succeeds. Second: notify-send itself.
    execFileMock
      .mockResolvedValueOnce({ stdout: '/usr/bin/notify-send', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    await notify({ title: 'Idle', body: 'take a walk' });

    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock.mock.calls[0]).toEqual(['which', ['notify-send']]);
    expect(execFileMock.mock.calls[1]).toEqual([
      'notify-send',
      ['--', 'Idle', 'take a walk'],
    ]);
  });

  test('passes quotes and special chars as raw args (no shell)', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: '/usr/bin/notify-send', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    await notify({ title: 'Idle', body: 'say "hi"; $rm -rf /' });
    const [, args] = execFileMock.mock.calls[1]!;
    expect(args).toEqual(['--', 'Idle', 'say "hi"; $rm -rf /']);
  });

  test('leading-dash body is not interpreted as a notify-send flag', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: '/usr/bin/notify-send', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    // Model output that starts with `-` or `--` — without the separator,
    // notify-send would treat this as an option.
    await notify({
      title: 'Idle',
      body: '--help --urgency=critical # ignored after --',
    });
    const [, args] = execFileMock.mock.calls[1]!;
    expect(args).toEqual([
      '--',
      'Idle',
      '--help --urgency=critical # ignored after --',
    ]);
    // Separator comes before any user content.
    expect(args.indexOf('--')).toBe(0);
  });

  test('leading-dash title is also guarded by the separator', async () => {
    execFileMock
      .mockResolvedValueOnce({ stdout: '/usr/bin/notify-send', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    await notify({ title: '-i critical', body: 'body' });
    const [, args] = execFileMock.mock.calls[1]!;
    expect(args).toEqual(['--', '-i critical', 'body']);
  });

  test('falls back to stderr when notify-send is missing', async () => {
    execFileMock.mockRejectedValueOnce(new Error('which: not found'));
    await notify({ title: 'Idle', body: 'hi' });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith('Idle: hi\n');
  });
});

describe('notify (other platforms)', () => {
  test('win32 falls straight to stderr without shelling out', async () => {
    process.env.IDLE_NOTIFY_PLATFORM = 'win32';
    await notify({ title: 'Idle', body: 'stub' });
    expect(execFileMock).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith('Idle: stub\n');
  });
});

describe('notify method: terminal', () => {
  test('darwin: stderr only, osascript is not spawned', async () => {
    process.env.IDLE_NOTIFY_PLATFORM = 'darwin';
    await notify({ title: 'Idle', body: 'take a break', method: 'terminal' });
    expect(execFileMock).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith('Idle: take a break\n');
  });

  test('linux: stderr only, notify-send is not spawned (no `which` either)', async () => {
    process.env.IDLE_NOTIFY_PLATFORM = 'linux';
    await notify({ title: 'Idle', body: 'take a break', method: 'terminal' });
    expect(execFileMock).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith('Idle: take a break\n');
  });

  test('sound is ignored when method is terminal', async () => {
    process.env.IDLE_NOTIFY_PLATFORM = 'darwin';
    await notify({
      title: 'Idle',
      body: 'take a break',
      sound: true,
      method: 'terminal',
    });
    expect(execFileMock).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith('Idle: take a break\n');
  });
});

describe('notify method: both', () => {
  test('darwin: osascript is called AND stderr gets title/body', async () => {
    process.env.IDLE_NOTIFY_PLATFORM = 'darwin';
    execFileMock.mockResolvedValue({ stdout: '', stderr: '' });

    await notify({ title: 'Idle', body: 'walk', method: 'both' });

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileMock.mock.calls[0]!;
    expect(cmd).toBe('osascript');
    expect(args[1]).toBe(
      'display notification "walk" with title "Idle"',
    );
    expect(stderrSpy).toHaveBeenCalledWith('Idle: walk\n');
  });

  test('linux: notify-send is called AND stderr gets title/body', async () => {
    process.env.IDLE_NOTIFY_PLATFORM = 'linux';
    execFileMock
      .mockResolvedValueOnce({ stdout: '/usr/bin/notify-send', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    await notify({ title: 'Idle', body: 'stretch', method: 'both' });

    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock.mock.calls[1]).toEqual([
      'notify-send',
      ['--', 'Idle', 'stretch'],
    ]);
    expect(stderrSpy).toHaveBeenCalledWith('Idle: stretch\n');
  });

  test('darwin: failing osascript does not suppress stderr line', async () => {
    process.env.IDLE_NOTIFY_PLATFORM = 'darwin';
    execFileMock.mockRejectedValue(new Error('osascript boom'));

    await notify({ title: 'Idle', body: 'walk', method: 'both' });

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith('Idle: walk\n');
  });

  test('sound is applied to the native call and stderr still runs', async () => {
    process.env.IDLE_NOTIFY_PLATFORM = 'darwin';
    execFileMock.mockResolvedValue({ stdout: '', stderr: '' });

    await notify({
      title: 'Idle',
      body: 'stretch',
      sound: true,
      method: 'both',
    });

    const [, args] = execFileMock.mock.calls[0]!;
    expect(args[1]).toContain('sound name "Ping"');
    expect(stderrSpy).toHaveBeenCalledWith('Idle: stretch\n');
  });

  test('linux with missing notify-send still writes stderr once', async () => {
    process.env.IDLE_NOTIFY_PLATFORM = 'linux';
    execFileMock.mockRejectedValueOnce(new Error('which: not found'));

    await notify({ title: 'Idle', body: 'walk', method: 'both' });

    // `which` was attempted; notify-send itself was not. Stderr fires exactly
    // once — the missing-tool path must not double-write when method='both'.
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith('Idle: walk\n');
  });
});

describe('notify method: explicit native and unknown', () => {
  test("explicit 'native' matches the default (undefined) behavior", async () => {
    process.env.IDLE_NOTIFY_PLATFORM = 'darwin';
    execFileMock.mockResolvedValue({ stdout: '', stderr: '' });

    await notify({ title: 'Idle', body: 'walk', method: 'native' });

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0]![0]).toBe('osascript');
    // Native delivered → no stderr fallback fired.
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  test('unknown method value is treated as native (forward compat)', async () => {
    process.env.IDLE_NOTIFY_PLATFORM = 'darwin';
    execFileMock.mockResolvedValue({ stdout: '', stderr: '' });

    await notify({
      title: 'Idle',
      body: 'walk',
      // Future methods should not break existing builds of notify().
      method: 'carrier-pigeon' as unknown as NotificationMethod,
    });

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0]![0]).toBe('osascript');
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

// ---- Decision RR: 2s subprocess timeouts bound native notifier delivery ----
describe('notify subprocess timeouts (Decision RR)', () => {
  test('darwin: wedged osascript times out near 2s; stderr fallback fires', async () => {
    process.env.IDLE_NOTIFY_PLATFORM = 'darwin';
    // Mock returns a never-resolving promise. The mock's internal timer
    // fires at options.timeout (2000ms) and signals a SIGTERM timeout —
    // mirroring real execFile behavior when the subprocess wedges.
    execFileMock.mockReturnValue(new Promise(() => {}));

    const start = Date.now();
    await notify({ title: 'Idle', body: 'hi' });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(1_900);
    expect(elapsed).toBeLessThan(2_500);
    expect(stderrSpy).toHaveBeenCalledWith('Idle: hi\n');
  }, 5_000);

  test('linux: wedged notify-send times out near 2s; stderr fallback fires', async () => {
    process.env.IDLE_NOTIFY_PLATFORM = 'linux';
    execFileMock
      // which resolves quickly
      .mockResolvedValueOnce({ stdout: '/usr/bin/notify-send', stderr: '' })
      // notify-send wedges
      .mockReturnValueOnce(new Promise(() => {}));

    const start = Date.now();
    await notify({ title: 'Idle', body: 'hi' });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(1_900);
    expect(elapsed).toBeLessThan(2_500);
    expect(stderrSpy).toHaveBeenCalledWith('Idle: hi\n');
  }, 5_000);

  test('linux: wedged `which` times out; stderr fallback, notify-send never attempted', async () => {
    process.env.IDLE_NOTIFY_PLATFORM = 'linux';
    execFileMock.mockReturnValue(new Promise(() => {}));

    const start = Date.now();
    await notify({ title: 'Idle', body: 'hi' });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(1_900);
    expect(elapsed).toBeLessThan(2_500);
    // Only the wedged `which` call was issued; notify-send wasn't spawned.
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0]).toEqual(['which', ['notify-send']]);
    expect(stderrSpy).toHaveBeenCalledWith('Idle: hi\n');
  }, 5_000);
});

describe('notify promise contract', () => {
  test('never rejects even when every strategy fails', async () => {
    process.env.IDLE_NOTIFY_PLATFORM = 'darwin';
    execFileMock.mockRejectedValue(new Error('nope'));
    await expect(
      notify({ title: 'Idle', body: 'anything' }),
    ).resolves.toBeUndefined();
  });

  test('catch-branch fallback: exec fails AND stderr.write throws → still resolves', async () => {
    // Exercises writeStderr path C only (no try-branch writeStderr).
    // Darwin → execFile rejects → catch block → writeStderr(C) must not
    // propagate its own throw.
    process.env.IDLE_NOTIFY_PLATFORM = 'darwin';
    execFileMock.mockRejectedValue(new Error('osascript boom'));
    stderrSpy.mockImplementation(() => {
      throw new Error('stderr boom');
    });

    await expect(
      notify({ title: 'Idle', body: 'anything' }),
    ).resolves.toBeUndefined();

    expect(stderrSpy).toHaveBeenCalled();
  });

  test('try-branch fallback: linux-no-notify-send AND stderr.write throws → still resolves', async () => {
    // Exercises writeStderr path A specifically. Without the swallow:
    //   1. `which notify-send` rejects → hasNotifySend returns false.
    //   2. try-branch writeStderr (A) throws → bubbles to catch.
    //   3. catch-branch writeStderr (C) also throws → escapes, rejects.
    // With the swallow, (A) returns normally and no catch is needed.
    process.env.IDLE_NOTIFY_PLATFORM = 'linux';
    execFileMock.mockRejectedValue(new Error('which: not found'));
    stderrSpy.mockImplementation(() => {
      throw new Error('stderr boom');
    });

    await expect(
      notify({ title: 'Idle', body: 'linux-no-notify' }),
    ).resolves.toBeUndefined();

    // The try-branch fallback was attempted at least once.
    expect(stderrSpy).toHaveBeenCalled();
  });

  test('other-platform fallback: win32 stderr.write throws → still resolves', async () => {
    // Exercises writeStderr path B (no catch, no exec, fallthrough).
    process.env.IDLE_NOTIFY_PLATFORM = 'win32';
    stderrSpy.mockImplementation(() => {
      throw new Error('stderr closed');
    });
    await expect(
      notify({ title: 'Idle', body: 'stub' }),
    ).resolves.toBeUndefined();
    expect(stderrSpy).toHaveBeenCalled();
  });
});

// ---- F-014: terminal writes go to /dev/tty first, stderr as fallback ----
//
// Claude Code's hook runner captures child-process stderr and doesn't
// forward it to the user's visible terminal, which rendered the terminal
// half of `method='terminal'` and `method='both'` invisible inside a live
// hook. `/dev/tty` (the controlling terminal) is owned by the terminal
// emulator rather than the process tree, so it bypasses that capture.
describe('notify terminal write to /dev/tty (F-014)', () => {
  test('darwin method=terminal writes via /dev/tty, not stderr', async () => {
    process.env.IDLE_NOTIFY_PLATFORM = 'darwin';
    // openSync succeeds — we got a controlling terminal.
    fsMock.openSync.mockReturnValue(99);

    await notify({ title: 'Idle', body: 'walk', method: 'terminal' });

    expect(fsMock.openSync).toHaveBeenCalledTimes(1);
    expect(fsMock.openSync).toHaveBeenCalledWith('/dev/tty', 'w');
    expect(fsMock.writeSync).toHaveBeenCalledTimes(1);
    expect(fsMock.writeSync).toHaveBeenCalledWith(99, 'Idle: walk\n');
    expect(fsMock.closeSync).toHaveBeenCalledWith(99);
    // /dev/tty succeeded — stderr must not double-write.
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  test('linux method=both writes to /dev/tty alongside notify-send', async () => {
    process.env.IDLE_NOTIFY_PLATFORM = 'linux';
    fsMock.openSync.mockReturnValue(7);
    execFileMock
      .mockResolvedValueOnce({ stdout: '/usr/bin/notify-send', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    await notify({ title: 'Idle', body: 'stretch', method: 'both' });

    expect(execFileMock.mock.calls[1]).toEqual([
      'notify-send',
      ['--', 'Idle', 'stretch'],
    ]);
    expect(fsMock.writeSync).toHaveBeenCalledWith(7, 'Idle: stretch\n');
    expect(fsMock.closeSync).toHaveBeenCalledWith(7);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  test('/dev/tty unavailable → falls back to stderr with the same line', async () => {
    process.env.IDLE_NOTIFY_PLATFORM = 'darwin';
    // beforeEach already makes openSync throw ENOENT; assert the fallback.

    await notify({ title: 'Idle', body: 'walk', method: 'terminal' });

    expect(fsMock.openSync).toHaveBeenCalledWith('/dev/tty', 'w');
    expect(fsMock.writeSync).not.toHaveBeenCalled();
    expect(fsMock.closeSync).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith('Idle: walk\n');
  });

  test('writeSync failure after open still closes fd and falls back to stderr', async () => {
    process.env.IDLE_NOTIFY_PLATFORM = 'darwin';
    fsMock.openSync.mockReturnValue(42);
    fsMock.writeSync.mockImplementation(() => {
      throw new Error('EPIPE');
    });

    await notify({ title: 'Idle', body: 'walk', method: 'terminal' });

    expect(fsMock.openSync).toHaveBeenCalledWith('/dev/tty', 'w');
    expect(fsMock.writeSync).toHaveBeenCalledWith(42, 'Idle: walk\n');
    // fd opened successfully — must be closed regardless of writeSync outcome.
    expect(fsMock.closeSync).toHaveBeenCalledWith(42);
    expect(stderrSpy).toHaveBeenCalledWith('Idle: walk\n');
  });

  test('win32 skips /dev/tty entirely and writes stderr directly', async () => {
    process.env.IDLE_NOTIFY_PLATFORM = 'win32';

    await notify({ title: 'Idle', body: 'stub', method: 'terminal' });

    expect(fsMock.openSync).not.toHaveBeenCalled();
    expect(fsMock.writeSync).not.toHaveBeenCalled();
    expect(fsMock.closeSync).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith('Idle: stub\n');
  });

  test('closeSync throwing does not propagate (never-throw contract)', async () => {
    process.env.IDLE_NOTIFY_PLATFORM = 'darwin';
    fsMock.openSync.mockReturnValue(11);
    fsMock.closeSync.mockImplementation(() => {
      throw new Error('EBADF');
    });

    await expect(
      notify({ title: 'Idle', body: 'walk', method: 'terminal' }),
    ).resolves.toBeUndefined();
    expect(fsMock.closeSync).toHaveBeenCalledWith(11);
  });
});

// ---- F-014: native-failure fallback also routes through /dev/tty --------
//
// When native delivery fails or is unavailable, the default/'native' path
// writes the text line via writeTerminal — same /dev/tty-then-stderr chain
// as method='terminal' and method='both'. Before F-014 this fallback went
// straight to stderr, which Claude Code captured. These tests pin the new
// behavior so a regression to direct-stderr would be caught.
describe('notify native-failure fallback uses /dev/tty (F-014)', () => {
  test('darwin: osascript fails → /dev/tty delivers the terminal line', async () => {
    process.env.IDLE_NOTIFY_PLATFORM = 'darwin';
    fsMock.openSync.mockReturnValue(33);
    execFileMock.mockRejectedValue(new Error('osascript boom'));

    await notify({ title: 'Idle', body: 'body' });

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(fsMock.openSync).toHaveBeenCalledWith('/dev/tty', 'w');
    expect(fsMock.writeSync).toHaveBeenCalledWith(33, 'Idle: body\n');
    expect(fsMock.closeSync).toHaveBeenCalledWith(33);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  test('linux: notify-send missing → /dev/tty delivers the terminal line', async () => {
    process.env.IDLE_NOTIFY_PLATFORM = 'linux';
    fsMock.openSync.mockReturnValue(44);
    execFileMock.mockRejectedValueOnce(new Error('which: not found'));

    await notify({ title: 'Idle', body: 'hi' });

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0]).toEqual(['which', ['notify-send']]);
    expect(fsMock.writeSync).toHaveBeenCalledWith(44, 'Idle: hi\n');
    expect(fsMock.closeSync).toHaveBeenCalledWith(44);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  test('darwin: osascript fails AND /dev/tty unavailable → stderr fallback', async () => {
    process.env.IDLE_NOTIFY_PLATFORM = 'darwin';
    // beforeEach default: openSync throws ENOENT.
    execFileMock.mockRejectedValue(new Error('osascript boom'));

    await notify({ title: 'Idle', body: 'body' });

    expect(fsMock.openSync).toHaveBeenCalledWith('/dev/tty', 'w');
    expect(fsMock.writeSync).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith('Idle: body\n');
  });

  test('linux: notify-send missing AND /dev/tty unavailable → stderr fallback', async () => {
    process.env.IDLE_NOTIFY_PLATFORM = 'linux';
    // beforeEach default: openSync throws ENOENT.
    execFileMock.mockRejectedValueOnce(new Error('which: not found'));

    await notify({ title: 'Idle', body: 'hi' });

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(fsMock.openSync).toHaveBeenCalledWith('/dev/tty', 'w');
    expect(fsMock.writeSync).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith('Idle: hi\n');
  });
});
