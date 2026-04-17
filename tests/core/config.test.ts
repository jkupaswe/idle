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
  ConfigParseError,
  ConfigValidationError,
  defaultConfig,
  isAbsolutePath,
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

  test('returns independent objects (not frozen — saveConfig accepts mutation)', () => {
    const a = defaultConfig();
    const b = defaultConfig();
    a.thresholds.time_minutes = 1;
    a.projects['/x'] = { enabled: false };
    expect(b.thresholds.time_minutes).toBe(45);
    expect(b.projects).toEqual({});
  });
});

describe('isAbsolutePath', () => {
  test('accepts POSIX absolute paths', () => {
    expect(isAbsolutePath('/')).toBe(true);
    expect(isAbsolutePath('/Users/j/proj')).toBe(true);
  });

  test('rejects relative / empty / non-slash paths', () => {
    expect(isAbsolutePath('')).toBe(false);
    expect(isAbsolutePath('relative/path')).toBe(false);
    expect(isAbsolutePath('./here')).toBe(false);
    expect(isAbsolutePath('C:\\Users\\j')).toBe(false);
  });
});

describe('loadConfig', () => {
  test('returns frozen defaults when file is missing and does not create it', () => {
    const p = cfgPath();
    const c = loadConfig(p);
    expect(c).toEqual(defaultConfig());
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.thresholds)).toBe(true);
    expect(Object.isFrozen(c.projects)).toBe(true);
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

  test('returned config is deep-frozen — mutation throws in strict mode', () => {
    const c = loadConfig(cfgPath());
    expect(() => {
      const mutable: { time_minutes: number } = c.thresholds;
      mutable.time_minutes = 999;
    }).toThrow(TypeError);
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

  test('throws ConfigParseError with the file path on malformed TOML', () => {
    const p = cfgPath();
    writeFileSync(p, 'this is = not valid = toml');
    expect(() => loadConfig(p)).toThrow(ConfigParseError);
    try {
      loadConfig(p);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigParseError);
      if (err instanceof ConfigParseError) {
        expect(err.name).toBe('ConfigParseError');
        expect(err.path).toBe(p);
      }
    }
  });

  test('throws ConfigValidationError on unknown tone preset', () => {
    const p = cfgPath();
    writeFileSync(p, '[tone]\npreset = "emoji-storm"\n');
    try {
      loadConfig(p);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      if (err instanceof ConfigValidationError) {
        expect(err.name).toBe('ConfigValidationError');
        expect(err.path).toBe(p);
        expect(err.errors.length).toBeGreaterThan(0);
        expect(err.errors[0]?.path).toBe('tone.preset');
      }
    }
  });

  test('throws ConfigValidationError on non-absolute project key', () => {
    const p = cfgPath();
    writeFileSync(p, '[projects]\n"not-absolute" = { enabled = false }\n');
    try {
      loadConfig(p);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      if (err instanceof ConfigValidationError) {
        expect(err.errors[0]?.path).toMatch(/projects\["not-absolute"\]/);
      }
    }
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

  test('refuses to save invalid config (throws ConfigValidationError)', () => {
    const bad = defaultConfig();
    bad.thresholds.time_minutes = -5;
    expect(() => saveConfig(bad, cfgPath())).toThrow(ConfigValidationError);
  });

  test('accepts a frozen Readonly<IdleConfig> returned by loadConfig', () => {
    const p = cfgPath();
    saveConfig(defaultConfig(), p);
    const frozen = loadConfig(p);
    expect(() => saveConfig(frozen, p)).not.toThrow();
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
  test('accepts the default config and returns a frozen config', () => {
    const result = validateConfig(defaultConfig());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config).toEqual(defaultConfig());
      expect(Object.isFrozen(result.config)).toBe(true);
    }
  });

  test('fills in defaults for missing fields and returns ok: true', () => {
    const result = validateConfig({ thresholds: { time_minutes: 77 } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.thresholds.time_minutes).toBe(77);
      expect(result.config.thresholds.tool_calls).toBe(40);
      expect(result.config.tone.preset).toBe('dry');
    }
  });

  test('rejects non-integer thresholds with a pathed issue', () => {
    const result = validateConfig({ thresholds: { time_minutes: 1.5 } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.path).toBe('thresholds.time_minutes');
      expect(result.errors[0]?.message).toMatch(/non-negative integer/);
    }
  });

  test('rejects unknown tone preset', () => {
    const result = validateConfig({ tone: { preset: 'cheerful' } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.path).toBe('tone.preset');
    }
  });

  test('rejects unknown notification method', () => {
    const result = validateConfig({ notifications: { method: 'webhook' } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.path).toBe('notifications.method');
    }
  });

  test('rejects malformed project override', () => {
    const result = validateConfig({
      projects: { '/abs': { enabled: 'yes' } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.path).toMatch(/projects\["\/abs"\]/);
    }
  });

  test('rejects non-absolute project key', () => {
    const result = validateConfig({
      projects: { 'relative/path': { enabled: false } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.message).toMatch(/absolute/);
    }
  });

  test('rejects non-object top-level value', () => {
    const a = validateConfig(null);
    expect(a.ok).toBe(false);
    const b = validateConfig('config');
    expect(b.ok).toBe(false);
  });

  test('accepts undefined as empty → defaults', () => {
    const result = validateConfig(undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config).toEqual(defaultConfig());
    }
  });

  test('accumulates multiple issues rather than stopping at the first', () => {
    const result = validateConfig({
      thresholds: { time_minutes: -1, tool_calls: 'ten' },
      tone: { preset: 'nope' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('error classes', () => {
  test('ConfigValidationError.name is the literal class name', () => {
    const err = new ConfigValidationError([
      { path: 'x', message: 'bad' },
    ]);
    expect(err.name).toBe('ConfigValidationError');
    expect(err).toBeInstanceOf(Error);
  });

  test('ConfigParseError preserves the underlying cause', () => {
    const cause = new Error('syntax');
    const err = new ConfigParseError('/tmp/x.toml', cause);
    expect(err.name).toBe('ConfigParseError');
    expect(err.path).toBe('/tmp/x.toml');
    expect(err.cause).toBe(cause);
  });
});
