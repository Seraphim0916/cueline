# Architecture

## System boundary

CueLine splits decision authority from local execution:

```text
ChatGPT web conversation (controller)
              ^  |
   observation|  |<CueLineControl>
              |  v
Codex + CueLine (intermediary and policy enforcement)
              |
              v
registered local workers and filesystem state
```

The ChatGPT web page is the top-level controller. It decides whether the run should dispatch work, wait, inspect evidence, complete, or stop as blocked. It has no direct local tools or filesystem access. Codex supplies the built-in in-app Browser (IAB); CueLine converts persisted local evidence into controller observations and converts a validated controller command into a local action.

CueLine is standalone. Its runtime does not import Omnilane or GPT Relay, and it does not read either project's state or configuration.

## Components

### Browser adapter

`src/browser/codex-iab/` implements a text-only adapter over Codex's IAB client. It claims an existing ChatGPT tab when possible, otherwise opens the requested ChatGPT URL. It fills the composer, waits for the DOM to settle as either `inline_ready` or `attachment_ready`, emits durable submission checkpoints, makes at most one send attempt, waits for a stable completed assistant message, and records the resulting conversation URL. ChatGPT may automatically convert a long text prompt into an attachment; this is supported without treating an empty composer as proof that nothing is ready.

Recovery is read-only. Inline turns normally require the exact last user prompt. A manually submitted attachment turn may instead be recovered only after an append-only operator confirmation and exact conversation, Pro model, and protocol/run/round/request envelope checks. Response text and the conversation URL are captured in the same DOM evaluation so navigation cannot mix evidence from two pages. Ambiguous clicks remain `possibly_sent`; CueLine never retries or coordinate-clicks after a possibly accepted send. Generation is active only when a Stop control is visible, enabled, and actionable; a hidden residual button cannot suppress a completed assistant response.

The adapter should receive the current injected browser explicitly. Its fallback resolution prefers `globalThis.browser`, then the legacy `globalThis.iab`, then `agent.browsers.get("iab")`. Plain Node does not provide these globals.

### Controller protocol

`src/protocol/` extracts the last complete `<CueLineControl>` envelope and validates it against the exact pending `run_id`, `round`, and `request_id`. Invalid output is returned to the same controller for a bounded repair attempt. This rejects stale replies and unrelated JSON from earlier parts of a conversation.

### Controller loop

`src/core/controller-loop.ts` advances the run:

1. Persist the intended controller turn.
2. Persist browser submission checkpoints around the send boundary.
3. With the built-in browser in caller mode, submit once, capture the exact `/c/...` URL, persist `submitted`, return `awaiting_controller`, and release the runtime lease. CueLine does not create a detached Node daemon because Codex's injected IAB object does not exist there.
4. A later continuation performs one read-only `observeTurn`. An unfinished Pro response returns `awaiting_controller` immediately without another send; an exact completed response is persisted.
5. Validate protocol identity and every pre-spawn route, then persist the accepted command.
6. In the default `caller` executor, persist `advise` jobs for coordination or `work` jobs for an explicit claim/start handoff to the current Codex. In double-authorized `process` execution, run registered workers through the local supervisor.
7. Snapshot the derived state.
8. Repeat through ownerless controller/caller pauses until `complete`, `blocked`, or the round limit is reached. Neither terminal action is accepted while any required or optional job remains pending/running.

The default limits are 12 controller rounds and two repair attempts per pending command. An explicit `maxRounds` is persisted with run creation and remains the total budget across split caller continuations; omitting it later reuses the persisted value, while a different value is rejected.

### Execution modes, routing, and runners

`caller` is the default for both `startCueLineRun` and `runCueLine`. A controller turn first returns `awaiting_controller` after its one durable submission; each continuation observes the same URL/request once and never resends. A controller `dispatch` creates durable pending jobs but is not execution. `advise` returns `awaiting_caller` and remains coordination-only. `work` requires an absolute workdir, returns `awaiting_caller_work`, and may mutate only after `claimCueLineCallerJob` and `startCueLineCallerJob` succeed. The claim binds run/job/task hash/workdir/caller/fencing token; an unstarted expired claim can be released and reclaimed, while continuation settles an expired started claim as terminal `ambiguous`. A result-submission intent precedes the terminal status so crash recovery can distinguish a durable completed result from lost ownership. ChatGPT only issued the text command—it did not use local tools.

`process` is opt-in twice: run creation requires `executor: "process"` and `allowProcessExecution: true`, and each non-terminal continuation must explicitly repeat the second authorization. `src/router/` chooses an enabled, available candidate before any process starts. The bundled route invokes `codex exec --ignore-user-config`, preventing hidden workers from loading user-configured MCP servers. `src/runners/` requires an explicitly registered `argv[0]`, uses `spawn` with `shell: false`, and never performs post-spawn fallback. `src/jobs/` coordinates foreground/background execution and persists resolved runner, PID, phase, last progress time, and safely observed model/provider metadata. Process execution defaults to two concurrent jobs globally and two per lane; an accepted batch containing any `work` job is serial. Owned process groups are settled on success, cancellation, and timeout so descendants are not left behind.

### Durable state

`src/state/` writes a per-run logical event log and an atomic disposable snapshot. The event log is authoritative and is replayed on load. Immutable fsynced sequence segments avoid a shared-host append lock; a durable legacy-prefix fence isolates still-loaded older writers. Runtime-authored events carry owner identity. Exact takeover intent is durable before replacement; the successful atomic lease replacement embeds the retired owner's sequence cutoff, so a failed replacement leaves the old owner authoritative while a committed cutoff keeps later writes visible for audit but unable to change replayed state. The cutoff is mirrored to immutable retirement evidence before the replacement lease is removed. Pending and recoverably abandoned controller turns, composer state, manual confirmation, and request-correlated browser failure evidence survive replay. A prompt is retried only when the exact sole pending request is proven `definitely_not_sent`; ambiguous submissions require read-only reconciliation. Job status files are atomically replaced, but authoritative terminal run events win if a retired owner writes a conflicting file later. Runtime leases serialize continuation and caller result submission; ownerless `controller_response_pending` and `caller_jobs_pending` phases are intentional healthy boundaries.

## Authority and trust

The controller can request local work, but a request is not equivalent to process access. CueLine applies these gates:

- exact run/round/request identity
- structurally valid command and unique `job_key`
- configured lane and pre-spawn candidate availability
- config-derived registered executable allow-list
- no shell interpolation
- deterministic job identity and duplicate-dispatch suppression
- caller work immutable claim/start/heartbeat/result fencing
- double authorization before process execution
- no nested CueLine routing (`CUELINE_DEPTH`)
- no retry after a worker has started

These gates reduce accidental execution ambiguity; they do not make an allowed worker harmless. The local Codex/operator environment remains responsible for filesystem, network, credential, and side-effect permissions granted to each registered executable.

## Data flow

1. The original user request becomes part of every controller observation.
2. Full job stdout and stderr remain in local status. Successful non-empty stdout is preferred for controller evidence, and all controller job evidence shares one 12,000-character budget with an explicit truncation notice. Each preferred evidence field carries a raw-character window, deterministic next offset, and content hash. An accepted single-job `inspect(job_ids, evidence_offset, evidence_hash)` allocates that budget to the named job and reads the next window without rerunning it. A changed evidence body invalidates the cursor before pages can be mixed.
3. ChatGPT returns a command; only the control envelope is machine-executed.
4. On `complete`, CueLine returns `final_delivery_text` to Codex.
5. On `blocked`, CueLine preserves the controller's reason and optional delivery text.

CueLine does not intentionally inspect or export cookies, tokens, environment secrets, or browser session material. The IAB uses the user's already authenticated page.

## Dependency model

The published JavaScript has zero runtime npm dependencies and uses Node built-ins. TypeScript and Node type definitions are development dependencies only. Live ChatGPT orchestration additionally depends on Codex's IAB runtime and ChatGPT's current web UI; the bundled default local route also expects the `codex` CLI on `PATH`. The core state, protocol, router, and fake tests run in plain Node.
