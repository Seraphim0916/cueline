# Upgrade preflight experiment

## Hypothesis and user value

Before replacing an installed CueLine version, operators need one read-only
command that proves the target is a valid forward upgrade and that local
configuration and durable state are safe to carry forward.

## Change boundary

- Adds `cueline upgrade preflight --to <version> [--json]`.
- Reads the current Node version, active routing configuration, state-home file
  type and permissions, and sanitized persisted run summaries.
- Never creates a state home, follows a state-home symlink, changes permissions,
  migrates files, cancels runs, launches a browser, or contacts a provider.
- Accepts stable semantic target versions only; it does not authorize downgrade
  or prerelease migration policy.

## Blocking conditions

- Invalid or older target version.
- Node older than 22.
- Routing configuration unreadable by the installed version.
- State home is a symlink, non-directory, unreadable, or grants group/other
  permissions.
- Any run is non-terminal or has unreadable durable evidence.

## Verified evidence

- Targeted integration tests: 5 passed, 0 failed.
- Full test suite: 495 passed, 0 failed.
- TypeScript build: passed.
- Plugin validation: passed.
- Real `./bin/cueline upgrade preflight --to 1.0.0 --json`: status `ready`
  with a missing isolated state home.
- The real CLI check verified that the missing state home remained absent.
- A persisted non-terminal run retained the exact event-log size and mtime
  across preflight.

## Rollback

Revert this branch's commit. It owns the preflight diagnostic, its tests and
documentation, plus focused health-command and help entries.

This experiment remains isolated on `codex/idea-upgrade-preflight`. It must not
be merged into `main`; Vincent decides whether it is selected or integrated.
