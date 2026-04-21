import type { Command } from 'commander';

import { loadConfig } from '../core/config.js';
import { readState, type ReadStateResult } from '../core/state.js';
import type { AbsolutePath, SessionEntry } from '../lib/types.js';

import { projectCwd } from './_shared.js';

export function register(program: Command): void {
  program
    .command('status')
    .description('Show install and enablement state for this directory.')
    .action(() => {
      const code = runStatus();
      process.exit(code);
    });
}

export function runStatus(): number {
  let cwd: AbsolutePath;
  try {
    cwd = projectCwd();
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }

  const config = loadConfig();
  const state = readState();
  const note = readStateNote(state);
  if (note !== null) process.stdout.write(`${note}\n`);

  const entries = Object.entries(state.state.sessions);
  const activeCount = entries.length;
  const pendingCount = entries.filter(
    ([, e]) => e.pending_checkin === true,
  ).length;
  const override = config.projects[cwd];
  const enabled = override === undefined || override.enabled === true;

  process.stdout.write(`active sessions: ${activeCount}\n`);
  process.stdout.write(`pending check-ins: ${pendingCount}\n`);
  process.stdout.write(
    `idle is: ${enabled ? 'enabled' : 'disabled'} for ${cwd}\n`,
  );
  process.stdout.write(
    `current thresholds: ${config.thresholds.time_minutes}m / ${config.thresholds.tool_calls} tool calls\n`,
  );

  if (activeCount > 0) {
    const now = new Date();
    for (const [id, entry] of entries) {
      process.stdout.write(`${formatActiveLine(id, entry, now)}\n`);
    }
  }
  return 0;
}

function readStateNote(result: ReadStateResult): string | null {
  switch (result.kind) {
    case 'fresh':
    case 'empty':
      return null;
    case 'recovered':
      return `Note: corrupt state file backed up to ${result.corruptBackupPath}.`;
    case 'partial':
      return `Note: ${result.droppedEntries} malformed session entries were backed up to ${result.backupPath}.`;
  }
}

function formatActiveLine(id: string, entry: SessionEntry, now: Date): string {
  const minutes = minutesBetween(entry.started_at, now);
  return `${id.slice(0, 8)}  started ${minutes}m ago  ${entry.tool_calls_since_checkin} tools since checkin`;
}

function minutesBetween(iso: string, end: Date): number {
  const start = new Date(iso);
  if (Number.isNaN(start.getTime())) return 0;
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 60_000));
}
