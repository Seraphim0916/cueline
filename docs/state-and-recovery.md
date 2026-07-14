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
- controller turn intent, response, rejection, and accepted command
- job registration and status changes
- notices
- complete, blocked, and failed terminal records

The controller turn is recorded before sending it through the browser, and a job is registered before its process starts. This ordering leaves evidence when an interruption occurs between intent and side effect.

## Snapshot

`snapshot.json` is a materialized view of the event stream. CueLine writes a temporary file in the same directory and renames it over the destination. A snapshot records its state protocol, run ID, and last applied sequence.

On load, CueLine uses a snapshot only when its identity and sequence are valid. A missing, malformed, or out-of-range snapshot is ignored and the state is replayed from event 1. Events newer than a valid snapshot are applied afterward.

The snapshot is therefore disposable. Do not edit the event log by hand; invalid JSON or a broken sequence makes the run unreplayable and is reported rather than silently skipped.

## Job status

The supervisor atomically replaces one JSON file per job. Foreground work returns its terminal status directly. Background work first persists `running`; later `wait` reads the same in-process completion or the last persisted status.

The run event log still records the controller-visible job transitions. A status file is execution evidence, not a substitute for the run history.

## Continue behavior

`continueCueLineRun` loads the exact `runId`, replays state as needed, and resumes the next controller round in the same persisted run. The public runtime also reuses the stored ChatGPT conversation URL unless an explicit compatible adapter is supplied.

- `complete` and `blocked` runs are returned as-is; they are not dispatched again.
- a non-terminal or locally `failed` run can be marked resumed and driven for additional rounds
- deterministic job IDs suppress a repeated dispatch already present in state
- running jobs can be observed or waited through their persisted status

Continuation cannot reconstruct an expired ChatGPT login, a deleted conversation, an unavailable registered executable, or an in-memory child process that disappeared with the host process. In those cases CueLine reports the concrete failure; it does not fabricate completion.

## Recovery procedure

1. Preserve `CUELINE_HOME`; do not delete the run directory.
2. Record the `runId` from the earlier result or directory name.
3. Restore access to the same ChatGPT conversation in Codex's built-in Browser.
4. Restore any locally required executable/configuration without copying browser credentials.
5. Call `continueCueLineRun({ runId, ... })`.
6. Treat the new terminal result as valid only after its event and job evidence is present.

For manual diagnosis, use `cueline jobs` and inspect the run's JSONL as read-only evidence. Do not copy `CUELINE_HOME` between machines as a replacement for local process or browser session state.
