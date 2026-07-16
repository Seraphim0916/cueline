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

On POSIX hosts, CueLine-owned run, event-segment, runtime, cancellation, and
job-status directories are created or tightened to mode `0700`; durable JSON
evidence is written with mode `0600`. A pre-existing permissive CueLine
directory is tightened on its next state write. State-directory symlinks are
rejected rather than followed, so permission repair cannot be redirected to an
unrelated path. Windows does not expose equivalent POSIX mode semantics and is
unchanged.

## Event log

The logical event log is append-only and authoritative. A legacy or atomically created first event may live in `events.jsonl`; subsequent events use one immutable file per sequence under `events.jsonl.segments/`. Each event contains a monotonically increasing sequence number, timestamp, type, payload, and an optional runtime owner ID. The writer fully writes and syncs a temporary segment, hard-links it to the sequence name with create-if-absent semantics, then syncs the containing directory before reporting success. A `legacy-fence.json` freezes the accepted byte prefix of an older JSONL writer, so a still-loaded pre-segment process may append a diagnostic suffix without creating duplicate logical sequence numbers. Concurrent or recovered writers that lose a sequence race reread and retry; no global event lock or partial segment becomes authoritative.

Important transitions include:

- run creation and resumption
- controller turn intent, submission checkpoints, response, reconciliation, rejection, and accepted command
- job registration and status changes
- caller work claim, start, heartbeat, release, result, and ambiguous terminalization
- notices
- complete, blocked, cancelled, and failed terminal records

The controller turn is recorded before sending it through the browser. The built-in adapter declares `submission_checkpoint_contract: write_ahead_v1`: if that exact turn remains `requested`, no submission side effect began. After the composer settles, CueLine records whether the prompt is `inline_ready` or `attachment_ready`. Immediately before its one allowed send attempt it records `controller_turn_submission_started` with `submission_state: submitting`; a verified post-click boundary becomes `submitted`, while an ambiguous click becomes `possibly_sent`. Other adapters do not inherit this proof merely because their turn still says `requested`. A verified response is recorded separately. A job is registered only after the entire dispatch has passed validation, and before either caller handoff or process start. This ordering leaves evidence when an interruption occurs between intent and side effect.

The absence of `controller_response_received` proves only that the local runtime did not record a response. It does **not** prove that ChatGPT did not answer. `run_failed` therefore retains the safe error message, stage, exact request ID, submission state, and known conversation URL. CueLine never treats a missing response event as permission to resend an ambiguous prompt.

## Snapshot

`snapshot.json` is a disposable materialized view of the event stream. CueLine writes a temporary file in the same directory and renames it over the destination. A snapshot records its state protocol, run ID, and last applied physical sequence. Loads replay the authoritative event stream from event 1 instead of trusting a snapshot that a retired owner could have replaced.

The snapshot is therefore disposable. Do not edit the event log by hand; invalid JSON or a broken sequence makes the run unreplayable and is reported rather than silently skipped.

## Job status

The supervisor atomically replaces one JSON status file per job. The first terminal result also creates an immutable `<job-id>.terminal` anchor; readers prefer that anchor, and a later `pending`/`running` write is rejected before it can authorize a duplicate spawn. Existing terminal-only JSON files are anchored lazily on the next write, so upgrades preserve legacy evidence. Status records include run ID, job key, lane, mode, resolved runner, PID, model/provider when safely observed, phase, and last progress time when available. The task remains in the authoritative run's `job_registered` event; `cueline jobs` joins that event metadata with the status file so the task is still visible. Caller jobs are visible as `pending` before the current Codex submits a terminal result. PID is diagnostic evidence only; CueLine never treats a PID alone as authority to kill a process. Foreground process work returns its terminal status directly. Background process work first persists `running`; later `wait` reads the same in-process completion or the last persisted status.

The run event log still records the controller-visible job transitions. A status file is execution evidence, not a substitute for the run history. `cueline jobs --json` includes run ID, job key, lane, mode, task, and PID when known. For process runs it adds a derived observed status: `running` requires active runtime ownership, `orphaned` means persisted process work says active but no owner is proven, `unverified` covers legacy records without a run ID, and `conflict` means a status file disagrees with authoritative run events. A conflict reports the authoritative `status`, exposes the file's value as `persistedStatus`, and omits the untrusted late result. Pending caller jobs remain pending during their intentional ownerless handoff.

## Runtime ownership and status

`runtime.json.fence` selects the authoritative owner-heartbeat record under `runtime.json.epochs/`. A live controller refreshes only its selected epoch and removes its own record on normal exit. If a mutation lock is abandoned, recovery rotates the fence before reuse; a paused old writer can then modify only its old epoch and cannot overwrite or release the new owner. An explicit takeover first records the operator's exact expected owner and heartbeat under `runtime.json.takeover-intents/`, including rejected race attempts. While holding the same mutation lock as runtime-authored event appends, a successful takeover then atomically replaces the exact stale lease and embeds the retired owner's last authoritative event sequence in the new lease. That lease replacement is the commit boundary: a failed replacement leaves the old owner authoritative. Before the replacement lease is removed, embedded cutoffs are also mirrored to immutable records under `runtime.json.retired-owners/`. Owner-tagged events after a committed cutoff remain on disk for audit but are excluded from state, status, reconciliation, and job metadata replay. Legacy `runtime.json` records are migrated on the first mutation. Creation and dead-owner retirement remain atomic and owner-checked so two sessions cannot both claim the run. `cueline run status <run-id> --json` combines event replay, lease ownership, cancellation requests, and job state.

- `phase: controller_response_pending`, `controller.pendingTurns === 1`, missing runtime ownership, and `safeNextAction: observe` mean the exact normally submitted request awaits one read-only observation. `controller.responseAccepted` is false even when `lastAcceptedAction` summarizes an earlier round; continue the same run without resend. `safeNextAction: reconcile` is reserved for ambiguous, manually submitted, or multiple pending turns.
- `phase: prompt_not_sent` and `safeNextAction: retry` mean the sole exact request is proven unsent by the built-in write-ahead contract or request-correlated `definitely_not_sent` failure evidence. CueLine abandons that attempt without consuming the round and reuses the same round number. A generic `requested` record is not enough.
- `controller.responseAccepted: true` means no newer turn is pending and a controller response was accepted. `lastAcceptedAction` and `lastAcceptedJobKeys` summarize what that accepted response ordered without dumping its full task text.
- `phase: jobs_running` plus `runtime.ownership: active` means local jobs are executing under the original loop.
- `executor: caller`, `phase: caller_jobs_pending`, `runtime.ownership: missing`, and `safeNextAction: execute_caller_jobs` is a healthy durable pause. The current Codex should execute the listed `advise` tasks and submit their results; it must not claim that ChatGPT used local tools.
- Caller handoff has no execution claim. Coordinate one session before doing the local advice; if two sessions execute it, the first terminal evidence submitted wins and the later submission returns `already_terminal`.
- `caller_work_pending` / `claim_caller_work` means no local mutation has begun. `caller_work_claimed` / `start_caller_work` means the immutable claim exists but still has `started=false`. `caller_work_running` / `continue_caller_work` authorizes only the exact claim owner to continue and heartbeat the started work. CLI run status is metadata-only: task bodies, caller identities, task hashes, workdirs, runtime owner IDs, claim IDs, and fencing tokens are omitted. The formal claim API returns the exact task and workdir after an atomic claim.
- One stale caller observer is automatically recoverable only when it owns exactly one normally submitted, non-manual turn with an exact matching ChatGPT URL, no active jobs, no pending command, and no cancellation. Status remains `controller_response_pending` / `observe`; continuation atomically fences the stale owner and performs read-only observation without resend. Every other stale state requires explicit takeover/reconciliation.
- `runtime_ownership_unknown` means persisted `running` is not proof of a live process. Except for the strict side-effect-free caller observer described above, `runtime_stale` requires explicit `cueline run takeover <run-id>` confirmation before the exact stale heartbeat can be retired. Active-looking process jobs are reported as `orphaned`.
- `runtime_active` means a live owner is still settling a failed state; another session must observe rather than continue.
- `controller_archive_pending` / `settle_controller_archive` means the controller run is already durably `complete`, but an explicitly enabled post-completion archive has not reached terminal proof. Only missing/released ownership may settle it. `archived`, `ambiguous`, and `failed` are terminal archive outcomes; never retry an `ambiguous` attempt.
- `continueAllowed: false` forbids `continueCueLineRun`. A caller-work state may separately authorize only the exact claim/start/continue API action named by `safeNextAction`; it never authorizes a browser resend.

## Continue behavior

Always run `cueline run status <run-id> --json` before continuation. `continueCueLineRun` loads the exact `runId`, replays state as needed, and resumes the same persisted run. The public runtime also reuses the stored ChatGPT conversation URL unless an explicit compatible adapter is supplied.

- `complete`, `blocked`, and `cancelled` runs are returned as-is; they are not dispatched again.
- When `archiveControllerConversationOnComplete` was fixed to `true` at creation, `complete` first becomes durable and then the exact bound ChatGPT conversation may be archived while Pro is idle. The built-in browser invokes a durable write-ahead hook immediately before one Archive click. A proven failure before that hook stays pending and may be retried; after it, any interruption or missing URL-change proof becomes `ambiguous` and cannot be retried. `blocked` and `cancelled` never archive.
- an active owner is rejected with `RUN_ALREADY_ACTIVE`; a stale lease requires dead-owner inspection; missing ownership is healthy only for a pristine or caller-mode run
- a non-terminal or locally `failed` run with no pending controller turn can be marked resumed and driven for additional rounds
- `maxRounds` is a durable total-run contract, not a per-continuation allowance; continuation reuses the created value and cannot widen or shrink it
- when the built-in write-ahead contract or a request-correlated failure proves the exact sole pending request `definitely_not_sent`, CueLine records that attempt as abandoned and safely retries without consuming the controller round
- a pending controller turn is reconciled read-only from the exact conversation before any new prompt is sent
- built-in caller/IAB submission returns `awaiting_controller` after one durable send and exact URL capture; each later continuation performs one non-blocking observation and returns the same status again if Pro is unfinished. Observation never presses `Answer now`, `Respond now`, `Stop`, or an equivalent interruption control
- inline reconciliation requires the page's last user message to equal the persisted prompt, a completed assistant response, and both Pro model checks
- attachment reconciliation may omit the full prompt from the visible user message, but only after a formal manual-send confirmation and exact conversation plus protocol/run/round/request/Pro evidence; response and URL must come from the same DOM snapshot; this exact operator-confirmed path also supports legacy turns that predate the durable assistant-count baseline, while automatic attachment recovery still requires that baseline
- a specified recoverably abandoned turn can be restored through that same append-only confirmation path when no same/newer command was accepted; it is never resent
- when more than one legacy turn is pending, CueLine stops with `MULTIPLE_CONTROLLER_TURNS_PENDING` rather than guessing
- deterministic job IDs suppress a repeated dispatch already present in state
- caller jobs are returned as `awaiting_caller`; after local execution, `submitCueLineCallerJobResult` persists the full result and continuation sends bounded evidence to the same controller
- caller `work` is returned as `awaiting_caller_work`; claim/start/heartbeat/result events are append-only, duplicate claims are fenced, an expired unstarted claim is releasable, and continuation settles an expired started claim as `ambiguous` before another controller turn
- `caller_work_result_submission_started` is persisted before the terminal status; an exact matching intent lets a post-crash retry import that durable terminal result even if the claim TTL elapsed between the two writes. A started caller work result other than `succeeded` is normalized to `ambiguous`
- `complete` and `blocked` are rejected while any required or optional job is pending/running, so a terminal command cannot orphan background work
- any non-normal process-loop exit cancels and settles its owned active jobs before releasing the runtime lease, including round-limit and controller-validation failures
- process jobs can be observed or waited through their persisted status

Caller advice remains coordination-only; caller work requires its durable claim lifecycle. Explicit process execution is gated by both executor selection and `allowProcessExecution: true`, defaults to at most two concurrent jobs globally and two per lane, and serializes a dispatch containing any `work` job.

## Cancellation and deadlines

`cueline run cancel <run-id>` and its `run stop` alias write a durable request. `cueline job cancel <run-id> <job-id>` targets one job. An active owner observes the request, sends `SIGTERM` to its owned child, escalates to `SIGKILL` after the grace interval, and persists the terminal transition. Cancelled `advise` is `cancelled`; started `work` is `ambiguous` because partial side effects cannot be disproved.

The CLI does not drive the browser. `doctor`, `routing`, `jobs`, `runs`, `run status`, `run verify`, `api path`, and `config path` are read-only. `runs` returns sanitized summaries only and reports corrupt run directories without hiding readable runs. `run verify` checks the creation marker, event sequence and authority replay, optional snapshot, runtime lease, and job status consistency without returning durable content. `install`/`uninstall` change only the package-owned skill link. `run reconcile`, `run takeover`, `run reconcile-runtime`, `run cancel`/`run stop`, and `job cancel` append audit evidence or mutate durable local state; their complete positional syntax and options are listed by `cueline help`.

When a process run has no verifiable owner, runtime reconciliation checks both the recorded process and its POSIX process group. Surviving processes block settlement. Only dead `advise` work can become failed/cancelled; `work` remains `ambiguous` when partial side effects cannot be disproved. `cueline run reconcile-runtime <run-id>` exposes this transition without treating a stale PID as kill authority.

`cueline run takeover <run-id>` is narrower: it atomically replaces only the exact stale owner/heartbeat observed by the command and writes `runtime_stale_owner_takeover_requested` followed by `runtime_stale_owner_takeover_confirmed` while the replacement lease is held. A fresh active heartbeat is refused. Caller runs return `next: continue`. Process runs always return `next: reconcile_runtime`, even when no job is currently recorded, so the advertised next step cannot bypass process-owner loss reconciliation.

`runTimeoutMs` is an optional owned-advancement deadline. In explicit process mode it limits that controller-loop invocation and aborts owned jobs before returning `RUN_TIMEOUT`. Caller runs intentionally release ownership at controller/caller pauses, so the value limits each `runCueLine` or `continueCueLineRun` call in which it is supplied; ownerless Pro thinking and local handoff time between calls are not counted. `defaultTimeoutMs` and job `timeout_ms` remain per-job limits. Runtime, process, cancellation-poll, and heartbeat timer values must be integer milliseconds from 1 through 2,147,483,647; invalid or overflowing values are rejected before browser, process, or lease side effects because Node otherwise reduces an overflowing timer to a near-immediate delay. A caller-side or tool-side wait timeout is not a cancellation signal; after one fires, inspect `run status`, then explicitly cancel if required. API callers may pass `signal` for direct cancellation propagation.

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
  --manual-send-confirmed \
  --conversation-url https://chatgpt.com/c/EXACT_CONVERSATION
```

The command accepts the first exact ChatGPT conversation URL created by that manual send, binds it in `controller_conversation_bound`, and writes `controller_turn_manual_submission_confirmed` under the same lease. Then continue with that request ID. Before the public continuation API records the same confirmation, it validates nested-routing safety, runtime limits, executor authorization, conversation identity, routing configuration, and Browser construction. A deterministic preflight failure therefore leaves the pending turn unchanged instead of returning an error after mutating it. CueLine accepts the response only if its Pro evidence and full envelope identity match; a mismatch is rejected without resend or dispatch.

Continuation cannot reconstruct an expired ChatGPT login, a deleted conversation, an unavailable registered executable, or an in-memory child process that disappeared with the host process. In those cases CueLine reports the concrete failure; it does not fabricate completion.

## Recovery procedure

1. Preserve `CUELINE_HOME`; do not delete the run directory.
2. Record the `runId` from the earlier result or directory name.
3. Restore access to the same ChatGPT conversation in Codex's built-in Browser.
4. Restore any locally required executable/configuration without copying browser credentials.
5. Run `cueline run status <run-id> --json`. If the owner is active, observe or cancel; do not continue. The strict read-only stale-observer case reports `controller_response_pending` / `observe` and can continue without resend. For every other stale owner, use `cueline run takeover <run-id> --json` once and follow its exact `next` field. An accepted response plus jobs must never be described as “waiting for ChatGPT.”
6. Inspect `loadCueLineRunState(runId, ...)` only when status says recovery is needed. If multiple `pendingControllerTurns` exist, match the visible page prompt and select its exact `requestId`.
7. For `controller_response_pending`, wait a bounded interval and call `continueCueLineRun` once; unfinished Pro output returns `awaiting_controller` without resend.
8. For `caller_jobs_pending`, execute only the listed `advise` jobs locally and submit each terminal result. For caller-work phases, follow only the exact claim/start/continue action, mutate only after start, heartbeat before claim expiry, and submit with the exact proof. Then call `continueCueLineRun`; no browser resend is involved.
9. Otherwise call `continueCueLineRun({ runId, conversationUrl, ... })` only when continuation is allowed. Add `reconcileRequestId` and `abandonOtherPendingTurns: true` only for an explicitly resolved multi-pending case. For a manually sent attachment, first use the formal reconcile command above.
10. If reconciliation fails, do not resend. Preserve the page and report the exact `CONTROLLER_RECONCILIATION_*`, `IAB_RECONCILIATION_FAILED`, or `TAB_RECOVERY_UNSAFE` error. Post-creation errors expose `details.run_id` for this recovery.
11. Treat the new terminal result as valid only after its event and job evidence is present.

For manual diagnosis, use `cueline jobs` and inspect the run's JSONL as read-only evidence. Do not copy `CUELINE_HOME` between machines as a replacement for local process or browser session state.
