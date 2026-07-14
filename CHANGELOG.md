# Changelog

## 0.1.4 - 2026-07-15

### Fixed

- Make `caller` the default executor for both `startCueLineRun` and `runCueLine`. A validated `dispatch` now returns durable pending jobs to the current Codex instead of silently spawning `codex exec`; the caller submits each terminal result before continuing the same run. Caller execution accepts `advise` only and rejects `work` until an execution claim can prevent duplicate side effects. The process executor remains available only when selected explicitly.
- Split built-in-IAB caller turns into durable submit and one-shot observe calls. After exactly one send, CueLine waits briefly for the exact `/c/...` URL, persists `submitted`, returns `awaiting_controller`, and releases the lease instead of tying Pro thinking to one outer 300-second waiter. Each continuation reads the same request/URL once and returns immediately if unfinished; it never resends. A delayed URL is captured safely, while a missing URL becomes `possibly_sent` rather than an unrecoverable fake pause. Post-creation failures expose `details.run_id` for reconciliation.
- Detach durable controller and caller pauses from a single tool wait: ownerless `controller_response_pending` and `caller_jobs_pending` phases are healthy, jobs stay visible with run ID/job key/lane/mode/task, concurrent continuation/result submission is lease-serialized, and `cueline run takeover` can retire one exact stale heartbeat without stealing an active owner. `controller.responseAccepted` is false while a newer turn is pending even when historical accepted-action evidence exists. Caller advice itself has no execution claim, so the first terminal evidence wins and `work` remains forbidden.
- Bound explicit process execution to two concurrent jobs globally and per lane by default, including advice still running from an earlier controller round, while preserving serial execution for any batch containing `work`. Process cancellation, timeout, and normal leader exit now settle the owned process group, including surviving descendants.
- Recognize ChatGPT's automatic long-prompt attachment conversion as `attachment_ready`. Submission waits for a stable inline prompt or a newly created attachment and performs at most one send attempt; an ambiguous locator/coordinate click becomes `possibly_sent` and is never retried.
- Add append-only manual submission recovery with `cueline run reconcile <run-id> --request-id <request-id> --manual-send-confirmed`. Recovery requires the exact conversation, exact Pro model evidence, and exact protocol/run/round/request envelope; it can restore a specified abandoned turn without resending or duplicate dispatch. Legacy manually sent attachment turns may lack a pre-submit assistant-count baseline; that path ignores an older assistant response until the exact pending envelope appears, while automatic attachment recovery still requires the baseline.
- Prefer successful non-empty worker stdout in controller observations, retain full stdout/stderr in job status, and enforce one global 12,000-character controller-evidence budget with an explicit truncation notice.
- Reject both `complete` and `blocked` while any required or optional job remains pending/running, preventing a terminal command from orphaning background work. Any non-normal process-loop exit (including round exhaustion or invalid controller output) now cancels and settles all owned active jobs before releasing its lease. When a retired runtime writes a conflicting job status file late, `cueline jobs` keeps the authoritative run-event status, marks `observedStatus: conflict`, exposes the file value as `persistedStatus`, and omits the untrusted late result.
- Make runtime creation, lease takeover, cancellation observation, caller result submission, and run creation race-safe. A crash-stale mutation lock rotates a persistent fence before reuse, and each lease generation writes a separate epoch record, so a paused old writer cannot overwrite or release the new owner. Event appends use complete fsynced, create-if-absent sequence segments instead of a persistent global event lock; a durable legacy-prefix fence prevents a still-loaded 0.1.3 writer from colliding with segmented sequence numbers. Runtime-authored events carry an owner ID. Exact takeover first preserves the operator's expected owner/heartbeat as immutable intent, then atomically replaces that exact stale lease while embedding its authoritative event cutoff; failed replacement leaves the old owner valid, while committed late events stay auditable but cannot mutate replayed state. The cutoff is mirrored to immutable retirement evidence before the replacement lease is removed. Ownerless process runs reconcile only after verifying that neither the recorded process nor its process group survives; otherwise they remain inspectable instead of being falsely settled.
- Bind recovery response text and its conversation URL in the same DOM evaluation, closing a navigation race where a later `tab.url()` read could otherwise validate evidence captured from another conversation.
- Report `safeNextAction: observe` only for one normally submitted controller turn that is waiting for Pro, while reserving `reconcile` for ambiguous, manually submitted, or multiple pending turns. CLI help now prints every positional argument and option, distinguishes read-only commands from append-only or state-changing recovery/cancellation commands, and returns the documented usage exit code 2 for invalid reconcile arguments.
- Enforce `maxRounds` as one durable total-run limit across caller pauses. A split caller run no longer resets its round budget on every `continueCueLineRun`; omitted continuation options reuse the persisted limit, and attempts to widen or shrink it are rejected before another controller turn is sent.

### Documentation

- Document the caller-first lifecycle, `awaiting_controller` submit/observe boundary, the web controller's text-only/no-local-tools boundary, explicit process execution and concurrency, attachment/manual reconciliation, ownerless controller/caller pauses, bounded evidence, exact CLI state effects, and the timeout semantics: `runTimeoutMs` limits each owned advancement in caller mode rather than ownerless Pro thinking between calls.

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
