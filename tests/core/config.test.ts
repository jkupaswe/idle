import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  defaultConfig,
  loadConfig,
  saveConfig,
  validateConfig,
} from '../../src/core/config.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'idle-config-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function cfgPath(): string {
  return join(tmp, 'config.toml');
}

describe('defaultConfig', () => {
  test('matches PRD §6.2 defaults', () => {
    const c = defaultConfig();
    expect(c.thresholds.time_minutes).toBe(45);
    expect(c.thresholds.tool_calls).toBe(40);
    expect(c.tone.preset).toBe('dry');
    expect(c.notifications.method).toBe('native');
    expect(c.notifications.sound).toBe(false);
    expect(c.projects).toEqual({});
  });

  test('returns independent objects', () => {
    const a = defaultConfig();
    const b = defaultConfig();
    a.thresholds.time_minutes = 1;
    a.projects['/x'] = { enabled: false };
    expect(b.thresholds.time_minutes).toBe(45);
    expect(b.projects).toEqual({});
  });
});

describe('loadConfig', () => {
  test('returns defaults when file is missing and does not create it', () => {
    const p = cfgPath();
    const c = loadConfig(p);
    expect(c).toEqual(defaultConfig());
    expect(() => readFileSync(p)).toThrow();
  });

  test('loads a valid TOML file', () => {
    const p = cfgPath();
    writeFileSync(
      p,
      [
        '[thresholds]',
        'time_minutes = 10',
        'tool_calls = 5',
        '',
        '[tone]',
        'preset = "absurdist"',
        '',
        '[notifications]',
        'method = "terminal"',
        'sound = true',
        '',
        '[projects]',
        '"/Users/j/proj" = { enabled = false }',
        '',
      ].join('\n'),
    );
    const c = loadConfig(p);
    expect(c.thresholds.time_minutes).toBe(10);
    expect(c.thresholds.tool_calls).toBe(5);
    expect(c.tone.preset).toBe('absurdist');
    expect(c.notifications.method).toBe('terminal');
    expect(c.notifications.sound).toBe(true);
    expect(c.projects['/Users/j/proj']).toEqual({ enabled: false });
  });

  test('fills in defaults for missing keys', () => {
    const p = cfgPath();
    writeFileSync(p, '[thresholds]\ntime_minutes = 90\n');
    const c = loadConfig(p);
    expect(c.thresholds.time_minutes).toBe(90);
    expect(c.thresholds.tool_calls).toBe(40);
    expect(c.tone.preset).toBe('dry');
    expect(c.notifications.method).toBe('native');
  });

  test('throws descriptive error on invalid TOML', () => {
    const p = cfgPath();
    writeFileSync(p, 'this is = not valid = toml');
    expect(() => loadConfig(p)).toThrow(/Failed to parse TOML config at/);
    expect(() => loadConfig(p)).toThrow(new RegExp(p.replace(/[/\\]/g, '.')));
  });

  test('unknown tone preset falls back to default', () => {
    const p = cfgPath();
    writeFileSync(p, '[tone]\npreset = "emoji-storm"\n');
    const c = loadConfig(p);
    expect(c.tone.preset).toBe('dry');
  });
});

describe('saveConfig', () => {
  test('round-trips the default config', () => {
    const p = cfgPath();
    saveConfig(defaultConfig(), p);
    const reloaded = loadConfig(p);
    expect(reloaded).toEqual(defaultConfig());
  });

  test('round-trips a customized config', () => {
    const p = cfgPath();
    const src = defaultConfig();
    src.thresholds.time_minutes = 15;
    src.tone.preset = 'earnest';
    src.notifications.sound = true;
    src.projects['/Users/j/a'] = { enabled: false };
    saveConfig(src, p);
    const reloaded = loadConfig(p);
    expect(reloaded).toEqual(src);
  });

  test('creates parent directory if missing', () => {
    const p = join(tmp, 'nested', 'dir', 'config.toml');
    saveConfig(defaultConfig(), p);
    expect(loadConfig(p)).toEqual(defaultConfig());
  });

  test('refuses to save invalid config', () => {
    const bad = defaultConfig();
    bad.thresholds.time_minutes = -5;
    expect(() => saveConfig(bad, cfgPath())).toThrow(
      /Refusing to save invalid Idle config/,
    );
  });

  test('leaves no .tmp artifact after write', () => {
    const p = cfgPath();
    saveConfig(defaultConfig(), p);
    const entries = readdirSync(tmp);
    const tmpArtifact = entries.find((e) => e.includes('.tmp-'));
    expect(tmpArtifact).toBeUndefined();
  });
});

describe('validateConfig', () => {
  test('accepts the default config', () => {
    expect(validateConfig(defaultConfig())).toEqual({ valid: true });
  });

  test('rejects non-integer thresholds', () => {
    const bad = defaultConfig();
    (bad as unknown as { thresholds: { time_minutes: unknown } }).thresholds.time_minutes = 1.5;
    const result = validateConfig(bad);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.join(' ')).toMatch(/time_minutes/);
    }
  });

  test('rejects unknown tone preset', () => {
    const bad = defaultConfig();
    (bad as unknown as { tone: { preset: unknown } }).tone.preset = 'cheerful';
    const result = validateConfig(bad);
    expect(result.valid).toBe(false);
  });

  test('rejects unknown notification method', () => {
    const bad = defaultConfig();
    (bad as unknown as { notifications: { method: unknown } }).notifications.method = 'webhook';
    const result = validateConfig(bad);
    expect(result.valid).toBe(false);
  });

  test('rejects malformed project override', () => {
    const bad = defaultConfig();
    (bad.projects as Record<string, unknown>)['/x'] = { enabled: 'yes' };
    const result = validateConfig(bad);
    expect(result.valid).toBe(false);
  });

  test('rejects non-object top-level value', () => {
    expect(validateConfig(null).valid).toBe(false);
    expect(validateConfig('config').valid).toBe(false);
  });
});

