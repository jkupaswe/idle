import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import TOML from '@iarna/toml';
import { afterEach, beforeEach, vi } from 'vitest';

import { IDLE_HOOK_EVENTS } from '../../src/core/settings.js';

export interface CliSandbox {
  /** Fake `~/.claude/` directory. */
  sandboxClaude: string;
  /** Fake `~/.idle/` directory root. */
  sandboxIdle: string;
  /** Directory containing stub hook scripts (one per IdleHookEvent). */
  sandboxHooks: string;
  /** Directory prepended to PATH containing a fake `claude` executable. */
  sandboxBin: string;
  /** Full path to the fake settings.json (may not exist until a command writes it). */
  settingsPath: string;
  /** Running capture of stdout + stderr across the test body. */
  captured: { stdout: string; stderr: string };
  /** Redirect the IDLE_CLAUDE_SETTINGS_PATH env var at a different sandbox. */
  setSettingsPath: (p: string) => void;
  /** Remove the fake `claude` from PATH without breaking node resolution. */
  removeClaudeFromPath: () => void;
  /** Delete a stub hook script (exercises the missing-script preflight). */
  removeHookScript: (filename: string) => void;
  /** Override whether `process.stdin.isTTY` reads as true. */
  setStdinTty: (isTty: boolean) => void;
}

export function useCliSandbox(prefix: string): CliSandbox {
  const ctx: CliSandbox = {
    sandboxClaude: '',
    sandboxIdle: '',
    sandboxHooks: '',
    sandboxBin: '',
    settingsPath: '',
    captured: { stdout: '', stderr: '' },
    setSettingsPath: (p: string) => {
      ctx.settingsPath = p;
      process.env.IDLE_CLAUDE_SETTINGS_PATH = p;
    },
    removeClaudeFromPath: () => {
      // Keep the dir containing the running `node` binary so execFile/child calls
      // still work; drop everything else (including our claude stub).
      process.env.PATH = dirname(process.execPath);
    },
    removeHookScript: (filename: string) => {
      rmSync(join(ctx.sandboxHooks, filename), { force: true });
    },
    setStdinTty: (isTty: boolean) => {
      Object.defineProperty(process.stdin, 'isTTY', {
        configurable: true,
        value: isTty,
      });
    },
  };

  let writeStdoutSpy: ReturnType<typeof vi.spyOn> | null = null;
  let writeStderrSpy: ReturnType<typeof vi.spyOn> | null = null;
  let originalPath: string | undefined;
  let originalIsTty: boolean | undefined;

  beforeEach(() => {
    ctx.sandboxClaude = mkdtempSync(join(tmpdir(), `idle-${prefix}-claude-`));
    ctx.sandboxIdle = mkdtempSync(join(tmpdir(), `idle-${prefix}-home-`));
    ctx.sandboxHooks = mkdtempSync(join(tmpdir(), `idle-${prefix}-hooks-`));
    ctx.sandboxBin = mkdtempSync(join(tmpdir(), `idle-${prefix}-bin-`));
    ctx.settingsPath = join(ctx.sandboxClaude, 'settings.json');

    // Stub every hook script so the preflight passes. Content doesn't
    // matter — the preflight only checks for file existence.
    for (const hook of IDLE_HOOK_EVENTS) {
      writeFileSync(
        join(ctx.sandboxHooks, hook.script),
        '// test stub — idle CLI sandbox\n',
      );
    }

    // Fake claude binary so `ensureClaudeOnPath()` resolves.
    const claudeBin = join(ctx.sandboxBin, 'claude');
    writeFileSync(claudeBin, '#!/bin/sh\nexit 0\n');
    chmodSync(claudeBin, 0o755);

    originalPath = process.env.PATH;
    process.env.IDLE_HOME = ctx.sandboxIdle;
    process.env.IDLE_CLAUDE_SETTINGS_PATH = ctx.settingsPath;
    process.env.IDLE_HOOKS_DIR = ctx.sandboxHooks;
    process.env.PATH = `${ctx.sandboxBin}${
      originalPath ? `:${originalPath}` : ''
    }`;

    originalIsTty = process.stdin.isTTY;
    ctx.setStdinTty(true);

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
    delete process.env.IDLE_HOOKS_DIR;
    if (originalPath !== undefined) process.env.PATH = originalPath;
    if (originalIsTty !== undefined) {
      Object.defineProperty(process.stdin, 'isTTY', {
        configurable: true,
        value: originalIsTty,
      });
    }
    rmSync(ctx.sandboxClaude, { recursive: true, force: true });
    rmSync(ctx.sandboxIdle, { recursive: true, force: true });
    rmSync(ctx.sandboxHooks, { recursive: true, force: true });
    rmSync(ctx.sandboxBin, { recursive: true, force: true });
  });

  return ctx;
}

export function simulateMissingClaudeHome(ctx: CliSandbox): () => void {
  const missing = join(ctx.sandboxClaude, 'gone', 'settings.json');
  ctx.setSettingsPath(missing);
  rmSync(ctx.sandboxClaude, { recursive: true, force: true });
  return () => mkdirSync(ctx.sandboxClaude, { recursive: true });
}

export function readToml(path: string): Record<string, unknown> {
  return TOML.parse(readFileSync(path, 'utf8'));
}
