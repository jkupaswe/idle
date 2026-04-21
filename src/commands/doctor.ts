/**
 * `idle doctor` — read-only diagnostic report.
 *
 * Runs a fixed list of 11 checks in order and prints one `[ok] ...` or
 * `[fail] ...` line per check. Every check runs even if an earlier one
 * fails (users want the full picture, not short-circuit). Exits 0 when
 * all checks pass, 1 otherwise.
 *
 * Doctor does not fix anything. It does not mutate config, settings, or
 * state (modulo the recovery-backup side effect `readState` may perform
 * when state.json is malformed — that's the state layer's contract, not
 * doctor's own write).
 */

import {
  accessSync,
  constants as fsConstants,
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type { Command } from 'commander';

import {
  ConfigParseError,
  ConfigValidationError,
  loadConfig,
} from '../core/config.js';
import {
  IDLE_EVENTS,
  IDLE_HOOK_EVENTS,
  defaultHooksDir,
  isIdleOwnedCommand,
} from '../core/settings.js';
import { readState } from '../core/state.js';
import {
  claudeSettingsPath,
  idleConfigPath,
  idleDebugLog,
  idleHome,
  idleSessionsDir,
  idleStatePath,
} from '../lib/paths.js';

import { resolveClaudeOnPath } from './_shared.js';

interface CheckResult {
  readonly ok: boolean;
  readonly message: string;
}

export function register(program: Command): void {
  program
    .command('doctor')
    .description('Run diagnostics on the Idle install.')
    .action(() => {
      const code = runDoctor();
      process.exit(code);
    });
}

export function runDoctor(): number {
  const results: CheckResult[] = [
    check(checkClaudeOnPath),
    check(checkClaudeHome),
    check(checkSettingsJson),
    check(checkIdleHooks),
    check(checkHookScriptsPresent),
    check(checkHookScriptsRegularFiles),
    check(checkIdleHome),
    check(checkConfig),
    check(checkStateJson),
    check(checkSessionsDir),
    check(checkDebugLog),
  ];

  for (const r of results) {
    process.stdout.write(`${render(r)}\n`);
  }

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;

  if (failCount === 0) {
    process.stdout.write(`${results.length} checks, all ok.\n`);
    return 0;
  }
  process.stdout.write(`${okCount} ok, ${failCount} failed.\n`);
  return 1;
}

function check(fn: () => CheckResult): CheckResult {
  try {
    return fn();
  } catch (err) {
    return fail(`unexpected error: ${errMessage(err)}`);
  }
}

function render(r: CheckResult): string {
  return r.ok ? `[ok] ${r.message}` : `[fail] ${r.message}`;
}

function ok(message: string): CheckResult {
  return { ok: true, message };
}

function fail(message: string): CheckResult {
  return { ok: false, message };
}

function checkClaudeOnPath(): CheckResult {
  const resolved = resolveClaudeOnPath();
  if (resolved === null) return fail('claude binary on PATH: not found');
  return ok(`claude binary on PATH (${resolved})`);
}

function checkClaudeHome(): CheckResult {
  // Derive the directory from the settings path so the IDLE_CLAUDE_SETTINGS_PATH
  // test override also redirects this check. Matches the derivation in
  // `_shared.ts#ensureClaudeHomeExists`.
  const dir = dirname(claudeSettingsPath());
  if (!existsSync(dir)) return fail('~/.claude/: missing');
  try {
    if (!statSync(dir).isDirectory()) {
      return fail('~/.claude/: not a directory');
    }
    accessSync(dir, fsConstants.W_OK);
  } catch (err) {
    return fail(`~/.claude/: ${errMessage(err)}`);
  }
  return ok('~/.claude/ exists and is writable');
}

function checkSettingsJson(): CheckResult {
  const path = claudeSettingsPath();
  if (!existsSync(path)) {
    return fail('~/.claude/settings.json: missing');
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    return fail(`~/.claude/settings.json: ${errMessage(err)}`);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('~/.claude/settings.json: expected a JSON object');
    }
  } catch (err) {
    return fail(`~/.claude/settings.json: ${errMessage(err)}`);
  }
  return ok('~/.claude/settings.json parses as JSON');
}

function checkIdleHooks(): CheckResult {
  const path = claudeSettingsPath();
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return fail('Idle hooks: settings.json unreadable');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail('Idle hooks: settings.json unparseable');
  }
  const found = eventsWithIdleHooks(parsed);
  const missing = IDLE_EVENTS.filter((e) => !found.has(e));
  if (missing.length === 0) return ok('Idle hooks installed for all four events');
  return fail(`Idle hooks missing: ${missing.join(', ')}`);
}

function eventsWithIdleHooks(parsed: unknown): Set<string> {
  const found = new Set<string>();
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return found;
  }
  const hooks = (parsed as { hooks?: unknown }).hooks;
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) {
    return found;
  }
  for (const [event, rawGroups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(rawGroups)) continue;
    for (const group of rawGroups) {
      if (group === null || typeof group !== 'object') continue;
      const groupHooks = (group as { hooks?: unknown }).hooks;
      if (!Array.isArray(groupHooks)) continue;
      for (const h of groupHooks) {
        if (
          h !== null &&
          typeof h === 'object' &&
          typeof (h as { command?: unknown }).command === 'string' &&
          isIdleOwnedCommand((h as { command: string }).command)
        ) {
          found.add(event);
          break;
        }
      }
    }
  }
  return found;
}

function checkHookScriptsPresent(): CheckResult {
  const dir = defaultHooksDir();
  const missing: string[] = [];
  for (const hook of IDLE_HOOK_EVENTS) {
    if (!existsSync(join(dir, hook.script))) missing.push(hook.script);
  }
  if (missing.length === 0) return ok('hook scripts present');
  return fail(`hook scripts missing: ${missing.join(', ')}`);
}

function checkHookScriptsRegularFiles(): CheckResult {
  const dir = defaultHooksDir();
  const nonFiles: string[] = [];
  for (const hook of IDLE_HOOK_EVENTS) {
    const abs = join(dir, hook.script);
    if (!existsSync(abs)) continue;
    try {
      if (!statSync(abs).isFile()) nonFiles.push(hook.script);
    } catch {
      nonFiles.push(hook.script);
    }
  }
  if (nonFiles.length === 0) return ok('hook scripts are regular files');
  return fail(`hook scripts are not regular files: ${nonFiles.join(', ')}`);
}

function checkIdleHome(): CheckResult {
  const dir = idleHome();
  if (!existsSync(dir)) return fail('~/.idle/: missing');
  try {
    if (!statSync(dir).isDirectory()) return fail('~/.idle/: not a directory');
    accessSync(dir, fsConstants.W_OK);
  } catch (err) {
    return fail(`~/.idle/: ${errMessage(err)}`);
  }
  return ok('~/.idle/ exists and is writable');
}

function checkConfig(): CheckResult {
  const path = idleConfigPath();
  if (!existsSync(path)) return fail('~/.idle/config.toml: missing');
  try {
    loadConfig(path);
  } catch (err) {
    if (
      err instanceof ConfigValidationError ||
      err instanceof ConfigParseError
    ) {
      return fail(`~/.idle/config.toml: ${err.message}`);
    }
    return fail(`~/.idle/config.toml: ${errMessage(err)}`);
  }
  return ok('~/.idle/config.toml valid');
}

function checkStateJson(): CheckResult {
  const path = idleStatePath();
  if (!existsSync(path)) return fail('~/.idle/state.json: missing');
  try {
    if (!statSync(path).isFile()) {
      return fail('~/.idle/state.json: not a regular file');
    }
  } catch (err) {
    return fail(`~/.idle/state.json: ${errMessage(err)}`);
  }
  const result = readState(path);
  return ok(`~/.idle/state.json readable (${result.kind})`);
}

function checkSessionsDir(): CheckResult {
  const dir = idleSessionsDir();
  if (!existsSync(dir)) return fail('~/.idle/sessions/: missing');
  try {
    if (!statSync(dir).isDirectory()) {
      return fail('~/.idle/sessions/: not a directory');
    }
  } catch (err) {
    return fail(`~/.idle/sessions/: ${errMessage(err)}`);
  }
  return ok('~/.idle/sessions/ exists');
}

function checkDebugLog(): CheckResult {
  const path = idleDebugLog();
  if (!existsSync(path)) return fail('~/.idle/debug.log: missing');
  try {
    if (!statSync(path).isFile()) {
      return fail('~/.idle/debug.log: not a regular file');
    }
    accessSync(path, fsConstants.W_OK);
  } catch (err) {
    return fail(`~/.idle/debug.log: ${errMessage(err)}`);
  }
  return ok('~/.idle/debug.log writable');
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
