# Known limitations

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
