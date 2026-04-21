# Known limitations

## Timeout-related edge cases

These are edge cases in the state-layer and notification-subsystem interaction that Idle does not perfectly handle in v1. Frequency in normal use is essentially zero; they're documented here for transparency.

### Spurious "Idle check-in" under sustained lock contention

If another Idle hook (PostToolUse, SessionStart, or SessionEnd) is holding the state lock for >500ms when a Stop event fires, Stop may emit an "Idle check-in" notification even if no check-in was actually pending. Lock holds in normal operation are single-digit milliseconds; this only occurs under filesystem pressure or extreme concurrent hook activity.

Tracked as F-007 for v1.1.

### Notification subprocess delivery is bounded but not async

Native notification delivery via osascript (macOS) or notify-send (Linux) blocks the Stop hook for up to 2 seconds per attempt while waiting on the subprocess. Combined with the 8-second `claude -p` timeout and the 500ms state-lock timeout, worst-case user-visible block time on Stop is approximately 11 seconds, not the design's stated 8-second target.

Tracked as F-009 for v1.1.

### Synchronous stop-hook behavior is a design tradeoff

Stop is installed with `async: false` so Claude Code blocks on its completion before continuing the user's next interaction. This is intentional — it prevents Claude from eating a notification the user hasn't seen yet. The cost is that any latency in break-suggestion generation is user-visible as a brief pause.

Not tracked for change; this is the product design.

## Install / uninstall edge cases

### Install failure during runtime-file provisioning

If `idle install` fails during the runtime-file provisioning step (after
hooks and config are written but before `~/.idle/state.json`,
`sessions/`, and `debug.log` are provisioned), the command exits 1 and
rolls back hooks + config. The runtime-file state is left in whatever
partial shape the failure produced.

Tracked as F-010 for v1.1: full three-way transaction across
`settings.json`, `config.toml`, and runtime files.

### Uninstall doesn't restore settings.json to pre-Idle state

`idle uninstall` removes Idle hook entries from `settings.json`. It does
not restore the user's `settings.json` to its pre-`idle install` state.
If the user had non-Idle hooks that were present before Idle was
installed, those are preserved. If they had no prior `settings.json`,
the file remains with an empty `{}` structure.

This is the intended behavior per PRD but worth documenting.
