# State and recovery

## Default layout

CueLine state defaults to:

```text
${CUELINE_HOME:-$HOME/.cueline}/
├── runs/
│   └── <run-id>/
│       ├── events.jsonl
│       ├── events.jsonl.segments/
│       ├── runtime.json.fence
│       ├── runtime.json.epochs/
│       ├── runtime.json.retired-owners/
│       ├── runtime.json.takeover-intents/
│       ├── cancel.json                 # only after run cancellation is requested
│       ├── job-cancellations/          # only after job cancellation is requested
│       └── snapshot.json
└── jobs/
    └── <job-id>.json
```

`CUELINE_HOME` accepts an absolute or relative path. `~` and `~/...` are expanded against `HOME`. Run and job IDs are validated before they are used in filesystem paths.

## Event log

The logical event log is append-only and authoritative. A legacy or atomically created first event may live in `events.jsonl`; subsequent events use one immutable file per sequence under `events.jsonl.segments/`. Each event contains a monotonically increasing sequence number, timestamp, type, payload, and an optional runtime owner ID. The writer fully writes and syncs a temporary segment, hard-links it to the sequence name with create-if-absent semantics, then syncs the containing directory before reporting success. A `legacy-fence.json` freezes the accepted byte prefix of an older JSONL writer, so a still-loaded pre-segment process may append a diagnostic suffix without creating duplicate logical sequence numbers. Concurrent or recovered writers that lose a sequence race reread and retry; no global event lock or partial segment becomes authoritative.

Important transitions include:

- run creation and resumption
- controller turn intent, submission checkpoints, response, reconciliation, rejection, and accepted command
- job registration and status changes
- notices
- complete, blocked, cancelled, and failed terminal records

The controller turn is recorded before sending it through the browser. After the composer settles, CueLine records whether the prompt is `inline_ready` or `attachment_ready`. Immediately before its one allowed send attempt it records `controller_turn_submission_started` with `submission_state: submitting`; a verified post-click boundary becomes `submitted`, while an ambiguous click becomes `possibly_sent`. A verified response is recorded separately. A job is registered only after the entire dispatch has passed validation, and before either caller handoff or process start. This ordering leaves evidence when an interruption occurs between intent and side effect.

The absence of `controller_response_received` proves only that the local runtime did not record a response. It does **not** prove that ChatGPT did not answer. `run_failed` therefore retains the safe error message, stage, exact request ID, submission state, and known conversation URL. CueLine never treats a missing response event as permission to resend an ambiguous prompt.

## Snapshot

`snapshot.json` is a disposable materialized view of the event stream. CueLine writes a temporary file in the same directory and renames it over the destination. A snapshot records its state protocol, run ID, and last applied physical sequence. Loads replay the authoritative event stream from event 1 instead of trusting a snapshot that a retired owner could have replaced.

The snapshot is therefore disposable. Do not edit the event log by hand; invalid JSON or a broken sequence makes the run unreplayable and is reported rather than silently skipped.

## Job status

The supervisor atomically replaces one JSON status file per job. Status records include run ID, job key, lane, mode, and—when a process exists—its child PID. The task remains in the authoritative run's `job_registered` event; `cueline jobs` joins that event metadata with the status file so the task is still visible. Caller jobs are visible as `pending` before the current Codex submits a terminal result. PID is diagnostic evidence only; CueLine never treats a PID alone as authority to kill a process. Foreground process work returns its terminal status directly. Background process work first persists `running`; later `wait` reads the same in-process completion or the last persisted status.

The run event log still records the controller-visible job transitions. A status file is execution evidence, not a substitute for the run history. `cueline jobs --json` includes run ID, job key, lane, mode, task, and PID when known. For process runs it adds a derived observed status: `running` requires active runtime ownership, `orphaned` means persisted process work says active but no owner is proven, `unverified` covers legacy records without a run ID, and `conflict` means a status file disagrees with authoritative run events. A conflict reports the authoritative `status`, exposes the file's value as `persistedStatus`, and omits the untrusted late result. Pending caller jobs remain pending during their intentional ownerless handoff.

## Runtime ownership and status

`runtime.json.fence` selects the authoritative owner-heartbeat record under `runtime.json.epochs/`. A live controller refreshes only its selected epoch and removes its own record on normal exit. If a mutation lock is abandoned, recovery rotates the fence before reuse; a paused old writer can then modify only its old epoch and cannot overwrite or release the new owner. An explicit takeover first records the operator's exact expected owner and heartbeat under `runtime.json.takeover-intents/`, including rejected race attempts. While holding the same mutation lock as runtime-authored event appends, a successful takeover then atomically replaces the exact stale lease and embeds the retired owner's last authoritative event sequence in the new lease. That lease replacement is the commit boundary: a failed replacement leaves the old owner authoritative. Before the replacement lease is removed, embedded cutoffs are also mirrored to immutable records under `runtime.json.retired-owners/`. Owner-tagged events after a committed cutoff remain on disk for audit but are excluded from state, status, reconciliation, and job metadata replay. Legacy `runtime.json` records are migrated on the first mutation. Creation and dead-owner retirement remain atomic and owner-checked so two sessions cannot both claim the run. `cueline run status <run-id> --json` combines event replay, lease ownership, cancellation requests, and job state.

- `phase: controller_response_pending`, `controller.pendingTurns === 1`, missing runtime ownership, and `safeNextAction: observe` mean the exact normally submitted request awaits one read-only observation. `controller.responseAccepted` is false even when `lastAcceptedAction` summarizes an earlier round; continue the same run without resend. `safeNextAction: reconcile` is reserved for ambiguous, manually submitted, or multiple pending turns.
- `controller.responseAccepted: true` means no newer turn is pending and a controller response was accepted. `lastAcceptedAction` and `lastAcceptedJobKeys` summarize what that accepted response ordered without dumping its full task text.
- `phase: jobs_running` plus `runtime.ownership: active` means local jobs are executing under the original loop.
- `executor: caller`, `phase: caller_jobs_pending`, `runtime.ownership: missing`, and `safeNextAction: execute_caller_jobs` is a healthy durable pause. The current Codex should execute the listed `advise` tasks and submit their results; it must not claim that ChatGPT used local tools.
- Caller handoff has no execution claim. Coordinate one session before doing the local advice; if two sessions execute it, the first terminal evidence submitted wins and the later submission returns `already_terminal`.
- `runtime_ownership_unknown` means persisted `running` is not proof of a live process. `runtime_stale` requires explicit `cueline run takeover <run-id>` confirmation before the exact stale heartbeat can be retired. Active-looking process jobs are reported as `orphaned`.
- `runtime_active` means a live owner is still settling a failed state; another session must observe rather than continue.
- `continueAllowed: false` is a hard stop. Another session must not send, resume, or claim completion.

## Continue behavior

Always run `cueline run status <run-id> --json` before continuation. `continueCueLineRun` loads the exact `runId`, replays state as needed, and resumes the same persisted run. The public runtime also reuses the stored ChatGPT conversation URL unless an explicit compatible adapter is supplied.

- `complete`, `blocked`, and `cancelled` runs are returned as-is; they are not dispatched again.
- an active owner is rejected with `RUN_ALREADY_ACTIVE`; a stale lease requires dead-owner inspection; missing ownership is healthy only for a pristine or caller-mode run
- a non-terminal or locally `failed` run with no pending controller turn can be marked resumed and driven for additional rounds
- `maxRounds` is a durable total-run contract, not a per-continuation allowance; continuation reuses the created value and cannot widen or shrink it
- when a failure proves `definitely_not_sent` for the exact sole pending request, CueLine records that turn as abandoned and safely starts a new round
- a pending controller turn is reconciled read-only from the exact conversation before any new prompt is sent
- built-in caller/IAB submission returns `awaiting_controller` after one durable send and exact URL capture; each later continuation performs one non-blocking observation and returns the same status again if Pro is unfinished
- inline reconciliation requires the page's last user message to equal the persisted prompt, a completed assistant response, and both Pro model checks
- attachment reconciliation may omit the full prompt from the visible user message, but only after a formal manual-send confirmation and exact conversation plus protocol/run/round/request/Pro evidence; response and URL must come from the same DOM snapshot; this exact operator-confirmed path also supports legacy turns that predate the durable assistant-count baseline, while automatic attachment recovery still requires that baseline
- a specified recoverably abandoned turn can be restored through that same append-only confirmation path when no same/newer command was accepted; it is never resent
- when more than one legacy turn is pending, CueLine stops with `MULTIPLE_CONTROLLER_TURNS_PENDING` rather than guessing
- deterministic job IDs suppress a repeated dispatch already present in state
- caller jobs are returned as `awaiting_caller`; after local execution, `submitCueLineCallerJobResult` persists the full result and continuation sends bounded evidence to the same controller
- `complete` and `blocked` are rejected while any required or optional job is pending/running, so a terminal command cannot orphan background work
- any non-normal process-loop exit cancels and settles its owned active jobs before releasing the runtime lease, including round-limit and controller-validation failures
- process jobs can be observed or waited through their persisted status

Caller mode accepts `advise` only. Explicit process execution defaults to at most two concurrent jobs globally and two per lane; a dispatch containing any `work` job is serialized in command order to avoid overlapping mutations.

## Cancellation and deadlines

`cueline run cancel <run-id>` and its `run stop` alias write a durable request. `cueline job cancel <run-id> <job-id>` targets one job. An active owner observes the request, sends `SIGTERM` to its owned child, escalates to `SIGKILL` after the grace interval, and persists the terminal transition. Cancelled `advise` is `cancelled`; started `work` is `ambiguous` because partial side effects cannot be disproved.

The CLI does not drive the browser. `doctor`, `routing`, `jobs`, `run status`, `api path`, and `config path` are read-only. `install`/`uninstall` change only the package-owned skill link. `run reconcile`, `run takeover`, `run reconcile-runtime`, `run cancel`/`run stop`, and `job cancel` append audit evidence or mutate durable local state; their complete positional syntax and options are listed by `cueline help`.

When a process run has no verifiable owner, runtime reconciliation checks both the recorded process and its POSIX process group. Surviving processes block settlement. Only dead `advise` work can become failed/cancelled; `work` remains `ambiguous` when partial side effects cannot be disproved. `cueline run reconcile-runtime <run-id>` exposes this transition without treating a stale PID as kill authority.

`cueline run takeover <run-id>` is narrower: it atomically replaces only the exact stale owner/heartbeat observed by the command and writes `runtime_stale_owner_takeover_requested` followed by `runtime_stale_owner_takeover_confirmed` while the replacement lease is held. A fresh active heartbeat is refused. The result says `next: continue` when the run may resume directly, or `next: reconcile_runtime` when ownerless process jobs must first pass process/group liveness reconciliation.

`runTimeoutMs` is an optional owned-advancement deadline. In explicit process mode it limits that controller-loop invocation and aborts owned jobs before returning `RUN_TIMEOUT`. Caller runs intentionally release ownership at controller/caller pauses, so the value limits each `runCueLine` or `continueCueLineRun` call in which it is supplied; ownerless Pro thinking and local handoff time between calls are not counted. `defaultTimeoutMs` and job `timeout_ms` remain per-job limits. A caller-side or tool-side wait timeout is not a cancellation signal; after one fires, inspect `run status`, then explicitly cancel if required. API callers may pass `signal` for direct cancellation propagation.

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

When ChatGPT converted the prompt into an attachment and the operator manually performed the one send, record the confirmation formally instead of editing `events.jsonl`:

```bash
cueline run reconcile RUN_ID \
  --request-id REQUEST_ID \
  --manual-send-confirmed
```

The command requires the exact persisted conversation and writes `controller_turn_manual_submission_confirmed`. Then continue with that request ID. CueLine accepts the response only if its Pro evidence and full envelope identity match; a mismatch is rejected without resend or dispatch.

Continuation cannot reconstruct an expired ChatGPT login, a deleted conversation, an unavailable registered executable, or an in-memory child process that disappeared with the host process. In those cases CueLine reports the concrete failure; it does not fabricate completion.

## Recovery procedure

1. Preserve `CUELINE_HOME`; do not delete the run directory.
2. Record the `runId` from the earlier result or directory name.
3. Restore access to the same ChatGPT conversation in Codex's built-in Browser.
4. Restore any locally required executable/configuration without copying browser credentials.
5. Run `cueline run status <run-id> --json`. If the owner is active, observe or cancel; do not continue. If it is stale, use `cueline run takeover <run-id> --json` once and follow its exact `next` field. `controller_response_pending` means observe the same submitted turn; an accepted response plus jobs means do not call that accepted round “waiting for ChatGPT.”
6. Inspect `loadCueLineRunState(runId, ...)` only when status says recovery is needed. If multiple `pendingControllerTurns` exist, match the visible page prompt and select its exact `requestId`.
7. For `controller_response_pending`, wait a bounded interval and call `continueCueLineRun` once; unfinished Pro output returns `awaiting_controller` without resend.
8. For `caller_jobs_pending`, execute only the listed `advise` jobs locally, submit each terminal result, then call `continueCueLineRun`; no browser resend is involved.
9. Otherwise call `continueCueLineRun({ runId, conversationUrl, ... })` only when continuation is allowed. Add `reconcileRequestId` and `abandonOtherPendingTurns: true` only for an explicitly resolved multi-pending case. For a manually sent attachment, first use the formal reconcile command above.
10. If reconciliation fails, do not resend. Preserve the page and report the exact `CONTROLLER_RECONCILIATION_*`, `IAB_RECONCILIATION_FAILED`, or `TAB_RECOVERY_UNSAFE` error. Post-creation errors expose `details.run_id` for this recovery.
11. Treat the new terminal result as valid only after its event and job evidence is present.

For manual diagnosis, use `cueline jobs` and inspect the run's JSONL as read-only evidence. Do not copy `CUELINE_HOME` between machines as a replacement for local process or browser session state.
