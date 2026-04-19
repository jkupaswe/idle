import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import TOML from '@iarna/toml';
import { afterEach, beforeEach, vi } from 'vitest';

export interface CliSandbox {
  /** Fake `~/.claude/` directory. Exists on disk. */
  sandboxClaude: string;
  /** Fake `~/.idle/` directory root. Exists on disk (empty). */
  sandboxIdle: string;
  /** Full path to the fake settings.json (may not exist until a command writes it). */
  settingsPath: string;
  /** Running capture of stdout + stderr across the test body. */
  captured: { stdout: string; stderr: string };
  /** Redirect the IDLE_CLAUDE_SETTINGS_PATH env var at a different sandbox. */
  setSettingsPath: (p: string) => void;
}

/**
 * Wire up a per-test sandbox for CLI command tests. Registers its own
 * `beforeEach` / `afterEach`, so tests just read fields off the returned
 * object. Use this for any test that invokes `runInit`, `runInstall`,
 * or `runUninstall` in-process.
 */
export function useCliSandbox(prefix: string): CliSandbox {
  const ctx: CliSandbox = {
    sandboxClaude: '',
    sandboxIdle: '',
    settingsPath: '',
    captured: { stdout: '', stderr: '' },
    setSettingsPath: (p: string) => {
      ctx.settingsPath = p;
      process.env.IDLE_CLAUDE_SETTINGS_PATH = p;
    },
  };
  let writeStdoutSpy: ReturnType<typeof vi.spyOn> | null = null;
  let writeStderrSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    ctx.sandboxClaude = mkdtempSync(join(tmpdir(), `idle-${prefix}-claude-`));
    ctx.sandboxIdle = mkdtempSync(join(tmpdir(), `idle-${prefix}-home-`));
    ctx.settingsPath = join(ctx.sandboxClaude, 'settings.json');
    process.env.IDLE_HOME = ctx.sandboxIdle;
    process.env.IDLE_CLAUDE_SETTINGS_PATH = ctx.settingsPath;

    ctx.captured.stdout = '';
    ctx.captured.stderr = '';
    writeStdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown): boolean => {
        ctx.captured.stdout += String(chunk);
        return true;
      });
    writeStderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown): boolean => {
        ctx.captured.stderr += String(chunk);
        return true;
      });
  });

  afterEach(() => {
    writeStdoutSpy?.mockRestore();
    writeStderrSpy?.mockRestore();
    delete process.env.IDLE_HOME;
    delete process.env.IDLE_CLAUDE_SETTINGS_PATH;
    rmSync(ctx.sandboxClaude, { recursive: true, force: true });
    rmSync(ctx.sandboxIdle, { recursive: true, force: true });
  });

  return ctx;
}

/**
 * Swap the sandbox to a settings.json path whose parent directory does
 * not exist — used by "refuses to run when ~/.claude/ is missing" tests.
 * Returns a cleanup function that restores a writable sandbox for
 * afterEach's rmSync.
 */
export function simulateMissingClaudeHome(ctx: CliSandbox): () => void {
  const missing = join(ctx.sandboxClaude, 'gone', 'settings.json');
  ctx.setSettingsPath(missing);
  rmSync(ctx.sandboxClaude, { recursive: true, force: true });
  return () => mkdirSync(ctx.sandboxClaude, { recursive: true });
}

export function readToml(path: string): Record<string, unknown> {
  return TOML.parse(readFileSync(path, 'utf8'));
}
