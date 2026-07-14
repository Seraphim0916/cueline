# State and recovery

## Default layout

CueLine state defaults to:

```text
${CUELINE_HOME:-$HOME/.cueline}/
├── runs/
│   └── <run-id>/
│       ├── events.jsonl
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
- complete, blocked, and failed terminal records

The controller turn is recorded before sending it through the browser. Immediately before the send click, CueLine records `controller_turn_submission_started` with `submission_state: possibly_sent`; after the click it records `controller_turn_submitted`. A verified response is recorded separately. A job is registered only after the entire dispatch has passed pre-spawn route validation, and before its process starts. This ordering leaves evidence when an interruption occurs between intent and side effect.

The absence of `controller_response_received` proves only that the local runtime did not record a response. It does **not** prove that ChatGPT did not answer. `run_failed` therefore retains the safe error message, stage, exact request ID, submission state, and known conversation URL. CueLine never treats a missing response event as permission to resend an ambiguous prompt.

## Snapshot

`snapshot.json` is a materialized view of the event stream. CueLine writes a temporary file in the same directory and renames it over the destination. A snapshot records its state protocol, run ID, and last applied sequence.

On load, CueLine uses a snapshot only when its identity and sequence are valid. A missing, malformed, or out-of-range snapshot is ignored and the state is replayed from event 1. Events newer than a valid snapshot are applied afterward.

The snapshot is therefore disposable. Do not edit the event log by hand; invalid JSON or a broken sequence makes the run unreplayable and is reported rather than silently skipped.

## Job status

The supervisor atomically replaces one JSON file per job. Foreground work returns its terminal status directly. Background work first persists `running`; later `wait` reads the same in-process completion or the last persisted status.

The run event log still records the controller-visible job transitions. A status file is execution evidence, not a substitute for the run history.

## Continue behavior

`continueCueLineRun` loads the exact `runId`, replays state as needed, and resumes the same persisted run. The public runtime also reuses the stored ChatGPT conversation URL unless an explicit compatible adapter is supplied.

- `complete` and `blocked` runs are returned as-is; they are not dispatched again.
- a non-terminal or locally `failed` run with no pending controller turn can be marked resumed and driven for additional rounds
- when a failure proves `definitely_not_sent` for the exact sole pending request, CueLine records that turn as abandoned and safely starts a new round
- a pending controller turn is reconciled read-only from the exact conversation before any new prompt is sent
- reconciliation requires the page's last user message to equal the persisted prompt, the last message to be a completed assistant response, and both Pro model checks to pass
- when more than one legacy turn is pending, CueLine stops with `MULTIPLE_CONTROLLER_TURNS_PENDING` rather than guessing
- deterministic job IDs suppress a repeated dispatch already present in state
- running jobs can be observed or waited through their persisted status

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
5. Inspect `loadCueLineRunState(runId, ...)`. If multiple `pendingControllerTurns` exist, match the visible page prompt and select its exact `requestId`.
6. Call `continueCueLineRun({ runId, conversationUrl, ... })`. Add `reconcileRequestId` and `abandonOtherPendingTurns: true` only for an explicitly resolved multi-pending case.
7. If reconciliation fails, do not resend manually. Preserve the page and report the exact `CONTROLLER_RECONCILIATION_*`, `IAB_RECONCILIATION_FAILED`, or `TAB_RECOVERY_UNSAFE` error.
8. Treat the new terminal result as valid only after its event and job evidence is present.

For manual diagnosis, use `cueline jobs` and inspect the run's JSONL as read-only evidence. Do not copy `CUELINE_HOME` between machines as a replacement for local process or browser session state.
