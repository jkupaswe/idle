/**
 * Shared filesystem primitives for Idle.
 *
 * Two concerns kept in one small module so every caller that writes under
 * `~/.idle/` or `~/.claude/` routes through the same short-write-safe
 * atomic path:
 *
 * - `writeAllSync(fd, buffer)` — loops until every byte is written. Node's
 *   `writeSync` can return a partial byte count on NFS, FUSE, and some
 *   container overlays; a one-shot call could silently leave truncated
 *   JSON on disk.
 * - `atomicWriteFile(path, contents)` — write to a sibling temp file,
 *   `fsync`, `rename` over the target. Creates parent directories as
 *   needed.
 *
 * Used by T-005 (state.internal.ts) and T-006 (settings.ts) so a bug fix
 * in either landing point can't drift. Callers convert strings via
 * `Buffer.from(s, 'utf8')` when needed — the helper's signature is typed
 * Buffer to keep the encoding choice explicit at the call site.
 */

import { Buffer } from 'node:buffer';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

/**
 * Write `buffer` in full to the given file descriptor. Loops calling
 * `writeSync(fd, buffer, offset, remaining)` until the full length has
 * been written; throws if `writeSync` ever returns `<= 0` (which would
 * indicate a non-recoverable filesystem error).
 */
export function writeAllSync(fd: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.length) {
    const remaining = buffer.length - offset;
    const written = writeSync(fd, buffer, offset, remaining);
    if (written <= 0) {
      throw new Error(
        `writeAllSync: writeSync returned ${written} with ${remaining} bytes remaining`,
      );
    }
    offset += written;
  }
}

/**
 * Write `contents` to `path` atomically:
 * 1. Create parent directories.
 * 2. Write to `<path>.tmp-<pid>-<rand>` via `writeAllSync`.
 * 3. `fsync` the temp file.
 * 4. `rename` over the target.
 *
 * A partial write or a crash between steps 2 and 4 leaves the target
 * intact; only a successful rename is visible to other readers.
 */
export function atomicWriteFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const fd = openSync(tmp, 'w', 0o644);
  try {
    writeAllSync(fd, Buffer.from(contents, 'utf8'));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}
