// Worker process for the cross-process lock-contention test.
// Usage: node --import tsx state-worker.ts <state-path> <session-id> <tag>
//
// The worker only uses the public named helper incrementToolCounter — it
// does NOT touch _updateState. The parent test registers the session
// before spawning workers so each worker just increments.

import { incrementToolCounter } from '../../../src/core/state.js';
import { isSessionId, ms } from '../../../src/lib/types.js';

const [, , path, rawId, tag] = process.argv;
if (!path || !rawId) {
  console.error('state-worker: expected <state-path> <session-id> [tag]');
  process.exit(2);
}
if (!isSessionId(rawId)) {
  console.error(`state-worker: invalid session id ${rawId}`);
  process.exit(2);
}

// Thresholds of 0 mean "disabled"; the increment just bumps counters
// without tripping pending_checkin.
const DISABLED = { time_minutes: 0, tool_calls: 0 } as const;

incrementToolCounter(
  rawId,
  { name: 'Worker', summary: tag ?? String(process.pid) },
  DISABLED,
  { path, timeoutMs: ms(10_000) },
).then(
  (result) => {
    if (!result.ok) {
      console.error(`state-worker: increment failed: ${result.reason}`);
      process.exit(1);
    }
    process.exit(0);
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
