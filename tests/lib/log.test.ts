/**
 * F-015 regression: `log()` must write to the IDLE_HOME-scoped debug log,
 * not the real `~/.idle/debug.log`.
 *
 * During T-020 Phase 5 verification, the production debug log was polluted
 * by test-fixture strings from tests that did not set IDLE_HOME. `log.ts`
 * routes through `paths.idleDebugLog()` at call time; this test pins that
 * invariant.
 */

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { log } from '../../src/lib/log.js';

let tempHome: string;
let savedIdleHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'idle-log-test-'));
  savedIdleHome = process.env.IDLE_HOME;
});

afterEach(() => {
  if (savedIdleHome === undefined) {
    delete process.env.IDLE_HOME;
  } else {
    process.env.IDLE_HOME = savedIdleHome;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

describe('log destination honors IDLE_HOME', () => {
  test('writes to IDLE_HOME-scoped debug.log, not homedir', () => {
    process.env.IDLE_HOME = tempHome;

    const marker = `should-not-appear-in-real-log-${randomUUID()}`;
    const realLogPath = join(homedir(), '.idle', 'debug.log');

    log('warn', 'f015 regression test', {
      marker,
    });

    // The sandboxed log has the line.
    const tempLogPath = join(tempHome, 'debug.log');
    expect(existsSync(tempLogPath)).toBe(true);
    const tempContent = readFileSync(tempLogPath, 'utf8');
    expect(tempContent).toContain('f015 regression test');
    expect(tempContent).toContain(marker);

    // The real log did not receive this test's unique marker. Avoid asserting
    // file size: other Idle processes may legitimately append while tests run.
    const realContent = existsSync(realLogPath)
      ? readFileSync(realLogPath, 'utf8')
      : '';
    expect(realContent).not.toContain(marker);
  });

  test('resolves destination at call time, not import time', () => {
    // First call with IDLE_HOME=A, second with IDLE_HOME=B. Each line must
    // land in its own file. If the destination were cached at import, the
    // second call would still write to A.
    const homeA = mkdtempSync(join(tmpdir(), 'idle-log-A-'));
    const homeB = mkdtempSync(join(tmpdir(), 'idle-log-B-'));
    try {
      process.env.IDLE_HOME = homeA;
      log('warn', 'first line', { slot: 'A' });

      process.env.IDLE_HOME = homeB;
      log('warn', 'second line', { slot: 'B' });

      const logA = readFileSync(join(homeA, 'debug.log'), 'utf8');
      const logB = readFileSync(join(homeB, 'debug.log'), 'utf8');
      expect(logA).toContain('first line');
      expect(logA).not.toContain('second line');
      expect(logB).toContain('second line');
      expect(logB).not.toContain('first line');
    } finally {
      rmSync(homeA, { recursive: true, force: true });
      rmSync(homeB, { recursive: true, force: true });
    }
  });
});
