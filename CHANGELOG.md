# Changelog

## 0.1.2 - 2026-07-15

### Fixed

- Wait up to five seconds for the ChatGPT composer model control to hydrate before reconciling an existing controller response. This prevents a visible `Pro` control from being rejected by an early DOM read.
- Preserve strict model verification during recovery: CueLine still requires both a `Pro` composer label and a Pro response model slug, and still refuses reconciliation when either proof is missing.
- Keep reconciliation read-only. Recovering an existing response does not resend the prompt, register a job, or execute Grove work.

### Documentation

- Clarify that `default` is a lane while `codex-default` is a runner candidate inside that lane.
- Document safe `0.1.2` continuation behavior for pending controller turns, exact prompt matching, and ambiguous submissions.
