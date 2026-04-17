// Worker process for the cross-process lock-contention test.
// Usage: node --import tsx state-worker.ts <state-path> <session-key> <tag>

import { updateState } from '../../../src/core/state.js';

const [, , path, key, tag] = process.argv;
if (!path || !key) {
  console.error('state-worker: expected <state-path> <session-key> [tag]');
  process.exit(2);
}

updateState(
  (s) => {
    const prev = s.sessions[key]?.total_tool_calls ?? 0;
    s.sessions[key] = {
      started_at: '2026-04-17T00:00:00.000Z',
      project_path: '/tmp',
      tool_calls_since_checkin: 0,
      total_tool_calls: prev + 1,
      last_checkin_at: null,
      checkins: [],
      last_tool_name: tag ?? String(process.pid),
    };
  },
  { path },
).then(
  (result) => process.exit(result.ok ? 0 : 1),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
