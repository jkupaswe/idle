import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

interface PackedFile {
  path: string;
  size: number;
  mode: number;
}

interface PackedResult {
  name: string;
  version: string;
  files: PackedFile[];
}

function loadPackageJson(): {
  bin?: Record<string, string> | string;
  files?: string[];
  main?: string;
  exports?: unknown;
} {
  const raw = readFileSync(join(repoRoot, 'package.json'), 'utf8');
  return JSON.parse(raw) as {
    bin?: Record<string, string> | string;
    files?: string[];
    main?: string;
    exports?: unknown;
  };
}

function runNpmPack(): PackedResult {
  const stdout = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    // npm writes human-readable progress to stderr; ignore it.
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const parsed = JSON.parse(stdout) as PackedResult[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`Unexpected npm pack output: ${stdout.slice(0, 200)}`);
  }
  return parsed[0]!;
}

function normalizeBin(
  bin: Record<string, string> | string | undefined,
): string[] {
  if (bin === undefined) return [];
  if (typeof bin === 'string') return [bin];
  return Object.values(bin);
}

function relPath(absolute: string): string {
  return relative(repoRoot, absolute);
}

function expandAllowlistEntry(
  entry: string,
): { exists: false } | { exists: true; files: string[] } {
  const abs = join(repoRoot, entry);
  if (!existsSync(abs)) return { exists: false };
  const stat = statSync(abs);
  if (stat.isFile()) return { exists: true, files: [entry] };
  if (stat.isDirectory()) {
    const out: string[] = [];
    walk(abs, out);
    return { exists: true, files: out };
  }
  return { exists: true, files: [] };
}

function walk(dir: string, into: string[]): void {
  for (const child of readdirSync(dir)) {
    const abs = join(dir, child);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      walk(abs, into);
    } else if (stat.isFile()) {
      into.push(relPath(abs));
    }
  }
}

describe('package tarball shape (F-001)', () => {
  const pkg = loadPackageJson();
  const packed = runNpmPack();
  const shipped = new Set(packed.files.map((f) => f.path));

  test('npm pack returns at least one file', () => {
    expect(packed.files.length).toBeGreaterThan(0);
  });

  test('every bin entry exists on disk and is in the tarball', () => {
    const binPaths = normalizeBin(pkg.bin);
    expect(binPaths.length).toBeGreaterThan(0);
    for (const declared of binPaths) {
      const normalized = declared.replace(/^\.\//, '');
      const abs = join(repoRoot, normalized);
      expect(existsSync(abs), `bin path ${declared} is missing on disk`).toBe(
        true,
      );
      expect(
        shipped.has(normalized),
        `bin path ${normalized} is missing from tarball`,
      ).toBe(true);
    }
  });

  test('files allowlist has no stale entries (every declared path exists on disk)', () => {
    const allowlist = pkg.files ?? [];
    for (const entry of allowlist) {
      const abs = join(repoRoot, entry);
      expect(
        existsSync(abs),
        `files allowlist references ${entry} but it does not exist on disk`,
      ).toBe(true);
    }
  });

  test('every declared allowlist file ships in the tarball', () => {
    const allowlist = pkg.files ?? [];
    for (const entry of allowlist) {
      const result = expandAllowlistEntry(entry);
      if (!result.exists) continue;
      for (const file of result.files) {
        expect(
          shipped.has(file),
          `allowlist entry ${entry} expects ${file} in tarball`,
        ).toBe(true);
      }
    }
  });

  test('ships package.json (always, per npm convention)', () => {
    expect(shipped.has('package.json')).toBe(true);
  });

  test('does not ship test, build, or config files', () => {
    const forbidden = [
      'tsconfig.json',
      'vitest.config.ts',
      'vitest.config.js',
      '.gitignore',
      'package-lock.json',
      'TASKS.md',
      'PRD.md',
      'CLAUDE.md',
    ];
    for (const path of forbidden) {
      expect(shipped.has(path), `tarball must not ship ${path}`).toBe(false);
    }
    for (const path of shipped) {
      expect(
        path.startsWith('tests/') ||
          path.startsWith('dist/') ||
          path.startsWith('node_modules/') ||
          path.startsWith('.git/'),
        `tarball must not ship ${path}`,
      ).toBe(false);
    }
  });
});
