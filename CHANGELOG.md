# Changelog

## 0.1.3 - 2026-07-15

### Fixed

- Add `cueline run status <run-id> --json` with accepted-controller-response evidence, the last accepted action and job keys, runtime ownership, safe next action, cancellation requests, and derived `orphaned` jobs. A new session no longer calls a persisted `running` value active when no live owner is proven.
- Add an owner heartbeat lease. A second session refuses to continue an active run, and a missing or stale owner requires inspection instead of another controller send.
- Run independent all-`advise` dispatches concurrently. Any dispatch containing `work` remains serial to avoid overlapping mutations.
- Add durable `run cancel` / `run stop` and `job cancel` requests, API `AbortSignal` support, and `runTimeoutMs`. Active `advise` cancellation becomes `cancelled`; interrupted `work` or ownerless legacy work becomes `ambiguous`.
- Persist job run ID, job key, lane, mode, and child PID for diagnosis. `cueline jobs --json` reports an observed status and never uses PID alone as kill authorization.
- Reject unsupported `runner_id` explicitly, require `runner`, and explain when a runner ID such as `codex-default` was placed in `lane`.
- Preserve built-in-browser attach failures instead of converting them to an empty tab list. Retry safe pre-submit attachment once, recheck an empty discovery result once, cache a new tab only after it loads, and use at most one CUA coordinate fallback after a transient send-locator failure.

### Documentation

- Require `run status` before continuation and distinguish controller response acceptance, local job execution, runtime ownership, and outer waiter timeout.
- Document cancellation, run-level deadlines, `advise` concurrency, `work` serialization, and stale-job recovery semantics.

## 0.1.2 - 2026-07-15

### Fixed

- Wait up to five seconds for the ChatGPT composer model control to hydrate before reconciling an existing controller response. This prevents a visible `Pro` control from being rejected by an early DOM read.
- Preserve strict model verification during recovery: CueLine still requires both a `Pro` composer label and a Pro response model slug, and still refuses reconciliation when either proof is missing.
- Keep reconciliation read-only. Recovering an existing response does not resend the prompt, register a job, or execute Grove work.

### Documentation

- Clarify that `default` is a lane while `codex-default` is a runner candidate inside that lane.
- Document safe `0.1.2` continuation behavior for pending controller turns, exact prompt matching, and ambiguous submissions.
