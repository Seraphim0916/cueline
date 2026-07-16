# Changelog

## 0.1.7 - 2026-07-16

### Added

- Add read-only operational surfaces for safe handoff and diagnosis: sanitized `runs`, causal `run doctor`, bounded `run watch`, metadata-only `run timeline`, explicit `run handoff`, durable-evidence `run verify`, controller-response `protocol lint`, machine-readable doctor/routing reports, and a non-mutating built-in-browser probe. These surfaces are strict allowlists and do not expose controller prompts, conversation URLs, job tasks/output, caller identities, task hashes, workdirs, runtime owner IDs, or untrusted exception text.
- Add deterministic pagination for `inspect(job_ids)` evidence. Pro can request the next exact slice using a content hash and character offset without rerunning a job or allowing one job to consume every later evidence window.
- Add opt-in `archiveControllerConversationOnComplete`. After a durable `complete`, CueLine may archive only the exact bound ChatGPT conversation while Pro is idle. The browser writes a durable checkpoint immediately before one Archive click; proven pre-click failures remain retryable, while a timeout, restart, missing checkpoint, navigation race, or missing proof becomes `ambiguous` and is never clicked again. `blocked` and `cancelled` runs are never archived.

### Fixed

- Require visible, actionable send and stop controls. Hidden, disabled, inert, ancestor-hidden, zero-geometry, localized, or residual controls no longer prove that a prompt can be sent or that Pro is still answering.
- Refuse ambiguous ChatGPT tab discovery instead of selecting the first match. Exact conversation matching now canonicalizes only benign browser decoration and rejects lookalike hosts, credentials, nested paths, duplicate physical tabs, and navigation races.
- Accept a fast completed response as post-click proof after a send timeout, while preserving the one-click rule whenever completion cannot be proven. Browser timing options and all Node timer values are validated before they can schedule a spin, overflow, or unsafe delay.
- Preflight continuation, manual reconciliation, caller-result timestamps, runtime options, routing configuration, process workdirs, and controller commands before any durable mutation or browser/process action. Unknown fields, inherited object properties, invalid lanes/runners, unknown job targets, and action-incompatible fields now fail atomically.
- Bound controller envelopes, dispatch size, job references, process stdout/stderr, controller event evidence, and accumulated notices. Truncation is explicit and deterministic; full local job evidence remains in the private job status store.
- Make job status transitions durably atomic and terminally fenced. Concurrent, stale, status-first, event-first, and late-conflicting writers cannot regress or overwrite the first authoritative terminal result; process progress writes are coalesced without losing the final update.
- Strictly validate persisted job status, runtime lease, retirement, takeover, and cancellation records, including identity, chronology, filenames, unknown fields, canonical timestamps, and authoritative run-event agreement. Corrupt optional evidence degrades diagnosis instead of becoming trusted state.
- Keep CueLine state directories owner-only and refuse symlink/file substitutions. Caller work claims pin the canonical workdir identity; process jobs bind an absolute workdir before registration, so recovery cannot silently execute in another checkout.
- Normalize multiline recovery evidence without erasing meaningful indentation, and validate conversation identity consistently across submission, observation, manual reconciliation, and archive recovery.
- Fence runtime and lane-concurrency option records against caller mutation, and prevent unsafe process fallback or implicit route changes after a job has started.
- Correct terminal status reporting: a completed, blocked, or cancelled run now reports `continueAllowed: false`; a pending post-completion archive has its own explicit `controller_archive_pending` / `settle_controller_archive` state.

### Verification

- Integrated 42 independently developed branches one at a time, running adversarial review and the full suite after every merge. Final integration passes 454/454 tests, TypeScript typecheck, plugin validation, fake smoke tests, and package-content checks.
- Verified a disposable real ChatGPT Web Pro run without interruption or `Answer now`: one prompt, exact `complete` delivery `LIVE_CONTROLLER_ARCHIVE_ACCEPTANCE_PASS`, one durable archive-start event, one archived event, zero ambiguous/failed archive events, and the pre-existing user conversation remained open.

## 0.1.6 - 2026-07-15

### Added

- Add a durable caller-work claim protocol for local mutations. A `work` dispatch in caller mode now pauses as `caller_work_pending`; `claimCueLineCallerJob`, `startCueLineCallerJob`, heartbeat, release, and result submission bind the exact run, job, task hash, absolute workdir, caller identity, expiry, and monotonically increasing fencing token. An unstarted expired claim is safely reclaimable; started work that loses its claim becomes `ambiguous` and is never automatically retried.
- Expose separate controller, caller-work, and process-execution status surfaces. Process status includes the resolved runner, model, provider, PID, phase, and last-progress timestamp; model/provider discovery keeps the first valid Codex header instead of allowing later untrusted job output to spoof it. Caller work reports pending, claimed, and running phases without pretending that Pro used local tools.

### Fixed

- Ignore hidden, disabled, inert, ancestor-hidden, zero-geometry, or otherwise non-actionable residual `Stop answering` buttons. A completed Pro response can now reconcile even when ChatGPT retains a hidden stop control in the DOM.
- Preserve exact `inspect(job_ids)` targets and allocate the bounded controller-evidence budget to those jobs first, so Pro receives the requested stdout instead of repeatedly seeing only terminal status.
- Recover only one precisely fenced, normally submitted caller observation after an outer timeout, and release every observation lease in `finally`. Ambiguous/manual/multiple turns, URL mismatches, jobs, commands, and cancellations remain in explicit reconciliation paths.
- Make caller-work result submission crash-recoverable with a durable result-intent event; reject clock regression, invalid or reversed timestamps, forged or out-of-order claims, duplicate terminal results, and release-after-start. Any non-success result after work starts is normalized to `ambiguous`.
- Require both `executor: "process"` and `allowProcessExecution: true` at run creation and every nonterminal continuation. Process work never exposes a caller-claim surface, and a failing diagnostic progress hook cannot break process supervision.
- Launch the bundled `codex-default` process route with `--ignore-user-config`, preventing hidden inheritance of user-configured MCP commands and their process arguments. The runner still uses registered argv directly without a shell.
- Prefer the current injected built-in Browser binding before fallback discovery, while keeping all controller observation read-only and never invoking `Answer now`, `Respond now`, `Stop`, or equivalent interruption controls.

### Verification

- Added adversarial coverage for hidden stop controls and hidden ancestors, inspected-output prioritization, stale observer fencing, caller claim races/restarts/expiry/result crashes/clock attacks, process double authorization, caller-vs-process status separation, diagnostic-hook failure, and bundled route isolation.
- Verified the real ChatGPT Web Pro path with a new conversation and new caller run: each prompt was sent once, no process or work job was started, bounded local evidence was returned through caller advice, and Pro was allowed to finish every reasoning turn without interruption. The terminal Pro verdict was `complete`, with no additional evidence requested for the five scoped blockers.

## 0.1.5 - 2026-07-15

### Fixed

- Add a durable built-in-browser `write_ahead_v1` submission contract. Only an exact request with that contract or request-correlated `definitely_not_sent` evidence may retry; the retry reuses the controller round. Status now reports `prompt_not_sent` / `retry` instead of incorrectly claiming that an unsent prompt is waiting for a response.
- Normalize contenteditable block newlines before prompt-readiness comparison, wait for the Pro composer label to hydrate before sending, extend new-conversation URL capture to 15 seconds for attachment conversion, prefer the active injected Browser binding, and recover from a stale selected webview by claiming the exact matching user conversation.
- Let manual submission confirmation atomically bind the first exact ChatGPT `/c/...` URL through the API and `cueline run reconcile ... --conversation-url URL`, without hand-editing the event log or resending.
- Make process recovery perform one-shot controller observation and always direct a stale process takeover through `reconcile_runtime`; the advertised reconcile-then-continue path is covered end to end.
- Fix nested `-h` / `--help` parsing and a date-dependent runtime-lease takeover test.
- Make the controller boundary explicit: Pro has no local tools or implicit path knowledge. Controller prompts and caller evidence require exact code/error identifiers, relevant code excerpts, absolute local paths, and an explicit request for any additional missing evidence. Pro observation must never invoke `Answer now`, `Respond now`, `Stop`, or an equivalent interruption control.

### Verification

- Real ChatGPT Web Pro attachment runs verified one-click submission, exact URL capture, fast `awaiting_controller` release, repeated one-shot observation while Pro reasoned, exact envelope reconciliation, zero duplicate jobs, and terminal `complete` without interruption.

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
