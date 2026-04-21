#!/usr/bin/env node
/**
 * Cross-platform `claude -p` stand-in for Stop-hook integration tests.
 *
 * Invoked from tests as:
 *   execClaudeLike(process.execPath, [fixturePath, ...flags], timeoutMs)
 *
 * Flags (all optional):
 *   --stdout <text>           Text written to stdout. JSON escape sequences
 *                             (\n, \t, etc.) are interpreted.
 *   --stderr <text>           Text written to stderr. Same escape handling.
 *   --exit <N>                Process exit code (default: 0).
 *   --sleep-ms <N>            Sleep before exiting (default: 0). Used for
 *                             the timeout integration test.
 *   --self-kill-after-ms <N>  After N ms, self-signal (default SIGKILL).
 *                             Used to prove `execClaudeLike` categorizes
 *                             non-SIGTERM signals as `'killed'` without
 *                             needing to expose the child handle.
 *   --self-signal <NAME>      Signal name for --self-kill-after-ms
 *                             (default: SIGKILL). Used to distinguish
 *                             self-inflicted SIGTERM from timeout-SIGTERM.
 *
 * No env vars, no IDLE_CLAUDE_BINARY, no production code paths touched.
 */

function parseArgs(argv) {
  const args = {
    stdout: '',
    stderr: '',
    exit: 0,
    sleepMs: 0,
    selfKillAfterMs: null,
    selfSignal: 'SIGKILL',
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--stdout':
        args.stdout = unescape(value ?? '');
        i++;
        break;
      case '--stderr':
        args.stderr = unescape(value ?? '');
        i++;
        break;
      case '--exit':
        args.exit = Number(value ?? 0);
        i++;
        break;
      case '--sleep-ms':
        args.sleepMs = Number(value ?? 0);
        i++;
        break;
      case '--self-kill-after-ms':
        args.selfKillAfterMs = Number(value ?? 0);
        i++;
        break;
      case '--self-signal':
        args.selfSignal = String(value ?? 'SIGKILL');
        i++;
        break;
      default:
        // Unknown flags silently ignored — the fixture stays permissive so
        // integration tests can add new flags without breaking old calls.
        break;
    }
  }
  return args;
}

function unescape(s) {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\\\/g, '\\');
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.selfKillAfterMs !== null && args.selfKillAfterMs >= 0) {
    setTimeout(() => {
      process.kill(process.pid, args.selfSignal);
    }, args.selfKillAfterMs).unref();
  }

  if (args.stdout.length > 0) {
    process.stdout.write(args.stdout);
  }
  if (args.stderr.length > 0) {
    process.stderr.write(args.stderr);
  }

  if (args.sleepMs > 0) {
    await sleep(args.sleepMs);
  }

  process.exit(args.exit);
}

main().catch((err) => {
  process.stderr.write(`fake-claude-p error: ${err?.message ?? String(err)}\n`);
  process.exit(2);
});
