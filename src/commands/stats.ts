import type { Command } from 'commander';

import { readState, type ReadStateResult } from '../core/state.js';
import { isSessionId } from '../lib/types.js';
import type { SessionEntry } from '../lib/types.js';

import { projectCwd } from './_shared.js';

export function register(program: Command): void {
  program
    .command('stats [session_id]')
    .description('Show session stats for this project or a specific session.')
    .action((sessionId: string | undefined) => {
      const code = runStats({ sessionId });
      process.exit(code);
    });
}

export function runStats(options: { sessionId?: string }): number {
  const result = readState();
  const note = readStateNote(result);
  if (note !== null) process.stdout.write(`${note}\n`);

  if (options.sessionId !== undefined) {
    return printSessionStats(options.sessionId, result.state.sessions);
  }
  return printProjectStats(result.state.sessions);
}

function printSessionStats(
  rawId: string,
  sessions: Readonly<Record<string, SessionEntry>>,
): number {
  if (!isSessionId(rawId)) {
    process.stderr.write(`Invalid session id: ${rawId}\n`);
    return 1;
  }
  const entry = sessions[rawId];
  if (entry === undefined) {
    process.stderr.write(`No such session: ${rawId}\n`);
    return 1;
  }
  process.stdout.write(`${formatSessionLine(rawId, entry)}\n`);
  return 0;
}

function printProjectStats(
  sessions: Readonly<Record<string, SessionEntry>>,
): number {
  let cwd: string;
  try {
    cwd = projectCwd();
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }

  const matching = Object.entries(sessions).filter(
    ([, entry]) => entry.project_path === cwd,
  );
  if (matching.length === 0) {
    process.stdout.write('No session data yet.\n');
    return 1;
  }

  const now = new Date();
  const totalToolCalls = matching.reduce(
    (s, [, e]) => s + e.total_tool_calls,
    0,
  );
  const totalCheckins = matching.reduce(
    (s, [, e]) => s + e.checkins.length,
    0,
  );
  const totalMs = matching.reduce(
    (s, [, e]) => s + msBetween(e.started_at, now),
    0,
  );

  process.stdout.write(`sessions: ${matching.length}\n`);
  process.stdout.write(`total tool calls: ${totalToolCalls}\n`);
  process.stdout.write(`total check-ins: ${totalCheckins}\n`);
  process.stdout.write(`total session time: ${formatMs(totalMs)}\n`);
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

function formatSessionLine(id: string, entry: SessionEntry): string {
  const idShort = id.slice(0, 8);
  const startedShort = formatStartedAtShort(entry.started_at);
  const duration = formatMs(msBetween(entry.started_at, new Date()));
  return `${idShort}  ${startedShort}  ${duration}  ${entry.total_tool_calls} tools  ${entry.checkins.length} check-ins`;
}

function formatStartedAtShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0m';
  const totalMins = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours === 0) return `${mins}m`;
  return `${hours}h${mins}m`;
}

function msBetween(iso: string, end: Date): number {
  const start = new Date(iso);
  if (Number.isNaN(start.getTime())) return 0;
  return Math.max(0, end.getTime() - start.getTime());
}
