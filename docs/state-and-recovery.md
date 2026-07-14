# State and recovery

## Default layout

CueLine state defaults to:

```text
${CUELINE_HOME:-$HOME/.cueline}/
├── runs/
│   └── <run-id>/
│       ├── events.jsonl
│       ├── runtime.json
│       ├── cancel.json                 # only after run cancellation is requested
│       ├── job-cancellations/          # only after job cancellation is requested
│       └── snapshot.json
└── jobs/
    └── <job-id>.json
```

`CUELINE_HOME` accepts an absolute or relative path. `~` and `~/...` are expanded against `HOME`. Run and job IDs are validated before they are used in filesystem paths.

## Event log

`events.jsonl` is append-only and authoritative. Each line contains a monotonically increasing sequence number, timestamp, event type, and payload. The writer opens the file with owner-only mode when creating it and calls `sync` after every append.

Important transitions include:

- run creation and resumption
- controller turn intent, submission checkpoints, response, reconciliation, rejection, and accepted command
- job registration and status changes
- notices
- complete, blocked, cancelled, and failed terminal records

The controller turn is recorded before sending it through the browser. Immediately before the send click, CueLine records `controller_turn_submission_started` with `submission_state: possibly_sent`; after the click it records `controller_turn_submitted`. A verified response is recorded separately. A job is registered only after the entire dispatch has passed pre-spawn route validation, and before its process starts. This ordering leaves evidence when an interruption occurs between intent and side effect.

The absence of `controller_response_received` proves only that the local runtime did not record a response. It does **not** prove that ChatGPT did not answer. `run_failed` therefore retains the safe error message, stage, exact request ID, submission state, and known conversation URL. CueLine never treats a missing response event as permission to resend an ambiguous prompt.

## Snapshot

`snapshot.json` is a materialized view of the event stream. CueLine writes a temporary file in the same directory and renames it over the destination. A snapshot records its state protocol, run ID, and last applied sequence.

On load, CueLine uses a snapshot only when its identity and sequence are valid. A missing, malformed, or out-of-range snapshot is ignored and the state is replayed from event 1. Events newer than a valid snapshot are applied afterward.

The snapshot is therefore disposable. Do not edit the event log by hand; invalid JSON or a broken sequence makes the run unreplayable and is reported rather than silently skipped.

## Job status

The supervisor atomically replaces one JSON file per job. New records include run ID, job key, lane, mode, and spawned child PID. PID is diagnostic evidence only; CueLine never treats a PID alone as authority to kill a process. Foreground work returns its terminal status directly. Background work first persists `running`; later `wait` reads the same in-process completion or the last persisted status.

The run event log still records the controller-visible job transitions. A status file is execution evidence, not a substitute for the run history. `cueline jobs --json` adds a derived observed status: `running` requires active runtime ownership, `orphaned` means the persisted job says running but the owner is not active, and `unverified` covers legacy records without a run ID.

## Runtime ownership and status

`runtime.json` is an owner heartbeat lease. A live controller refreshes it while it owns the run and marks it released on a normal exit. `cueline run status <run-id> --json` combines event replay, lease ownership, cancellation requests, and job state.

- `controller.responseAccepted: true` means a controller response was accepted. `lastAcceptedAction` and `lastAcceptedJobKeys` summarize what that response ordered without dumping its full task text. Do not describe this phase as waiting for ChatGPT.
- `phase: jobs_running` plus `runtime.ownership: active` means local jobs are executing under the original loop.
- `runtime_ownership_unknown` or `runtime_stale` means persisted `running` is not proof of a live process. Active-looking jobs are reported as `orphaned`.
- `runtime_active` means a live owner is still settling a failed state; another session must observe rather than continue.
- `continueAllowed: false` is a hard stop. Another session must not send, resume, or claim completion.

## Continue behavior

Always run `cueline run status <run-id> --json` before continuation. `continueCueLineRun` loads the exact `runId`, replays state as needed, and resumes the same persisted run. The public runtime also reuses the stored ChatGPT conversation URL unless an explicit compatible adapter is supplied.

- `complete`, `blocked`, and `cancelled` runs are returned as-is; they are not dispatched again.
- an active owner is rejected with `RUN_ALREADY_ACTIVE`; missing ownership is rejected with `RUN_OWNERSHIP_UNVERIFIED`; a stale lease requires explicit recovery
- a non-terminal or locally `failed` run with no pending controller turn can be marked resumed and driven for additional rounds
- when a failure proves `definitely_not_sent` for the exact sole pending request, CueLine records that turn as abandoned and safely starts a new round
- a pending controller turn is reconciled read-only from the exact conversation before any new prompt is sent
- reconciliation requires the page's last user message to equal the persisted prompt, the last message to be a completed assistant response, and both Pro model checks to pass
- when more than one legacy turn is pending, CueLine stops with `MULTIPLE_CONTROLLER_TURNS_PENDING` rather than guessing
- deterministic job IDs suppress a repeated dispatch already present in state
- running jobs can be observed or waited through their persisted status

All jobs in an accepted dispatch start concurrently only when every job is `advise`. A dispatch containing any `work` job is serialized in command order to avoid overlapping mutations.

## Cancellation and deadlines

`cueline run cancel <run-id>` and its `run stop` alias write a durable request. `cueline job cancel <run-id> <job-id>` targets one job. An active owner observes the request, sends `SIGTERM` to its owned child, escalates to `SIGKILL` after the grace interval, and persists the terminal transition. Cancelled `advise` is `cancelled`; started `work` is `ambiguous` because partial side effects cannot be disproved.

When a legacy run has no verifiable owner, run cancellation closes the run and changes active-looking jobs to `ambiguous`; it does not claim an unknown process was killed. A stale current-generation lease records the request but requires inspection rather than unsafe PID-based killing.

`runTimeoutMs` is an optional run-level deadline. It aborts the controller and owned jobs before returning `RUN_TIMEOUT`. `defaultTimeoutMs` and job `timeout_ms` remain per-job limits. A caller-side or tool-side wait timeout is not a cancellation signal; after one fires, inspect `run status`, then explicitly cancel if required. API callers may pass `signal` for direct cancellation propagation.

For one unambiguous pending turn, supply the exact conversation URL when it was not captured before the failure:

```js
await continueCueLineRun({
  runId,
  conversationUrl: "https://chatgpt.com/c/...",
});
```

For multiple legacy pending turns, first identify which visible page response is authoritative. Then select that exact persisted request and explicitly abandon the others:

```js
await continueCueLineRun({
  runId,
  conversationUrl: "https://chatgpt.com/c/...",
  reconcileRequestId: "msg_...",
  abandonOtherPendingTurns: true,
});
```

Do not set `abandonOtherPendingTurns` from sequence order alone. Use direct page evidence to match the visible user prompt to the persisted request. CueLine records every explicit abandonment.

Continuation cannot reconstruct an expired ChatGPT login, a deleted conversation, an unavailable registered executable, or an in-memory child process that disappeared with the host process. In those cases CueLine reports the concrete failure; it does not fabricate completion.

## Recovery procedure

1. Preserve `CUELINE_HOME`; do not delete the run directory.
2. Record the `runId` from the earlier result or directory name.
3. Restore access to the same ChatGPT conversation in Codex's built-in Browser.
4. Restore any locally required executable/configuration without copying browser credentials.
5. Run `cueline run status <run-id> --json`. If the owner is active, observe or cancel; do not continue. If the response is accepted and jobs exist, do not call that state “waiting for ChatGPT.”
6. Inspect `loadCueLineRunState(runId, ...)` only when status says recovery is needed. If multiple `pendingControllerTurns` exist, match the visible page prompt and select its exact `requestId`.
7. Call `continueCueLineRun({ runId, conversationUrl, ... })` only when continuation is allowed. Add `reconcileRequestId` and `abandonOtherPendingTurns: true` only for an explicitly resolved multi-pending case.
8. If reconciliation fails, do not resend manually. Preserve the page and report the exact `CONTROLLER_RECONCILIATION_*`, `IAB_RECONCILIATION_FAILED`, or `TAB_RECOVERY_UNSAFE` error.
9. Treat the new terminal result as valid only after its event and job evidence is present.

For manual diagnosis, use `cueline jobs` and inspect the run's JSONL as read-only evidence. Do not copy `CUELINE_HOME` between machines as a replacement for local process or browser session state.
