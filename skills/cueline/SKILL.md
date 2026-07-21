---
name: cueline
description: Use CueLine whenever the user wants a ChatGPT web Pro conversation to be the top-level text controller that plans, delegates, reviews evidence, or decides completion while the current Codex performs caller-mode advice or explicitly claimed local work. Trigger for requests to let web ChatGPT lead Codex, combine browser judgment with local tools, run a durable controller loop, or continue an existing CueLine run. CueLine uses Codex's built-in in-app Browser.
---

# CueLine

Use CueLine to put the current ChatGPT web conversation in charge of planning and next-step decisions while the current Codex remains the local intermediary and executor. The web page has no direct machine tools or filesystem access; it only sends validated text commands. Pro starts with no knowledge of local paths, repository layout, files, services, or runtime state. Never describe a Pro response as having inspected the repository or used local tools.

## Preconditions

1. Confirm the current host, operator, and work directory before local work.
2. Run `cueline version`, then `cueline doctor --json`, and require the same expected package version, Node.js 22 or newer, and `caller.ready: true` (plain `cueline doctor` remains available for humans). Run `cueline api path` and require the returned API module to exist. Do not reuse a module imported before a package update. `process.availableLanes` may be zero for caller mode; a usable process lane and `codex` CLI are required only when explicitly selecting the process executor. Use `cueline routing --json` when automation needs the selected runner ID; its output intentionally omits argv and environment values.
3. Use Codex's persistent Node REPL/runtime together with the built-in in-app Browser (IAB), not a separate plain `node` child, Chrome automation, or GPT Relay. Claim the logged-in `chatgpt.com` tab intended for this run. If CueLine reports `IAB_CHATGPT_TAB_AMBIGUOUS`, select the exact intended tab and retry; never choose an arbitrary matching tab or resend through another conversation.
4. CueLine requires the composer model selector to show `Pro` before every controller turn and requires the completed assistant message's `data-message-model-slug` to identify a Pro model. The account label (for example, a profile name ending in `Pro`) is subscription evidence only and never model evidence. Do not bypass `MODEL_SELECTOR_MISSING`, `PRO_MODEL_UNAVAILABLE`, `PRO_MODEL_SELECTION_FAILED`, or `PRO_MODEL_MISMATCH`.
5. Do not request, read, copy, or print cookies, access tokens, browser session material, or private environment values.
6. Keep v0.1 controller traffic text-only. ChatGPT may automatically convert a long filled prompt into an attachment; CueLine recognizes that state. Do not deliberately upload files, images, use Deep Research, Projects, or Apps. CueLine may switch the composer from another model to `Pro`; no other model switching is allowed.
7. Never interrupt Pro while it is answering. Never click or invoke `Answer now`, `Respond now`, `Stop`, or any equivalent acceleration/interruption control. While Pro is thinking, perform only the read-only observation path and return `awaiting_controller`.

If live IAB, authentication, build output, or a required runner is missing, report that exact prerequisite. Do not claim a live run from fake or read-only evidence.

## Start a run

Drive CueLine from Codex's Node runtime so the injected IAB object remains available. First run `cueline api path` in the local shell. In the Node REPL, assign its exact one-line output to `cuelineApiPath`; do not guess an npm prefix or repository location. Import the built public API; do not import Omnilane or GPT Relay.

```js
var cuelineApiPath = "/exact/output/from/cueline/api/path";
var expectedCueLineVersion = "exact output from cueline version";
const { pathToFileURL } = await import("node:url");
var cuelineModuleUrl = `${pathToFileURL(cuelineApiPath).href}?v=${encodeURIComponent(expectedCueLineVersion)}`;
const {
  CUELINE_VERSION,
  claimCueLineCallerJob,
  createCodexIabAdapter,
  continueCueLineRun,
  heartbeatCueLineCallerJob,
  releaseCueLineCallerJob,
  runCueLine,
  startCueLineCallerJob,
  startCueLineRun,
  submitCueLineCallerJobResult,
} = await import(cuelineModuleUrl);
if (CUELINE_VERSION !== expectedCueLineVersion) throw new Error(`CUELINE_VERSION_MISMATCH: loaded ${CUELINE_VERSION}, expected ${expectedCueLineVersion}`);

var iabBrowser = globalThis.browser;
if (!iabBrowser) throw new Error("IAB_BROWSER_MISSING: initialize and pass the current built-in Browser binding");
const turnMetadata = globalThis.nodeRepl?.requestMeta?.["x-codex-turn-metadata"];
const hasSessionId = typeof turnMetadata?.session_id === "string" && turnMetadata.session_id.length > 0;
const listedBrowsers = await globalThis.agent?.browsers?.list?.();
if (listedBrowsers !== undefined && listedBrowsers.length === 0) {
  const probableReason = hasSessionId ? "no-session-match" : "missing-session-metadata";
  throw new Error(
    `IAB_BACKEND_NOT_REGISTERED: ${probableReason}. Reopen or claim the IAB panel from the current Codex session, then retry continue. Do not resend the prompt and do not open a new Pro conversation.`,
  );
}
const browser = createCodexIabAdapter({
  browser: iabBrowser,
  // For continuing an existing bound run, pass the exact persisted URL:
  // conversationUrl: "https://chatgpt.com/c/..."
});

let result = await startCueLineRun({
  request: USER_REQUEST,
  // executor defaults to "caller". Select "process" only explicitly.
  // Opt in only when the user wants this exact controller conversation archived
  // after a durable `complete`: archiveControllerConversationOnComplete: true,
  // Optional here: runId, home, environment, now, maxRounds.
});
result = await continueCueLineRun({
  runId: result.runId,
  browser,
  // Optional while advancing: routingConfig/routingConfigPath, cwd,
  // defaultTimeoutMs, runTimeoutMs, signal, maxRepairAttempts.
});
```

`maxRounds` is fixed as a durable total-run limit at creation. Continuations should omit it and reuse the stored value; if supplied, it must exactly match or CueLine rejects the continuation without sending another controller turn.

`archiveControllerConversationOnComplete` is also a durable creation-time policy. It defaults to `false`. When explicitly enabled, CueLine first persists `run_completed`, then archives only the exact bound ChatGPT conversation and only while Pro is no longer answering. It never archives a `blocked` or `cancelled` run. The browser must finish a durable write-ahead checkpoint immediately before the Archive click. A proven failure before that checkpoint remains `pending` and may be retried; a timeout or restart after it, a missing checkpoint, or missing completion proof becomes `ambiguous` and is never retried automatically. A later continuation must omit the option or supply the exact stored value.

Pass the user's request faithfully. Do not silently widen it, and do not turn an analysis-only request into `work`. Prefer `startCueLineRun` followed by `continueCueLineRun`, so the durable `runId` is known before any browser send. `runCueLine` remains a convenience API and post-creation failures include `details.run_id`. In caller mode, both APIs pause at `awaiting_controller` after one durable send and later at `awaiting_caller` or `awaiting_caller_work`; a recovered non-terminal response with no caller handoff returns `ready` before any next controller send. A `dispatch` recovered through the narrow count-degraded accessibility exception is accepted durably but is not executed in that recovery call; only the next independent continuation may register its jobs. Neither API silently spawns a worker.

The web controller decides `dispatch`, `wait`, `inspect`, `complete`, or `blocked`. CueLine validates the exact pending identity and persists transitions. Under the default caller executor, a `dispatch` is only a durable work proposal. An `advise` job is handed to the current Codex without a side-effect claim. A `work` job remains unstarted until this exact caller claims and starts it through the public API. Never describe a Pro `dispatch` as local work having begun.

### Observe the controller turn

When the result is `awaiting_controller`, CueLine has submitted the exact request once, captured its exact conversation URL, released the runtime lease, and stopped holding the outer tool call open. Do not send or start another run. After a bounded backoff, call `continueCueLineRun` on the same `runId` and browser. It performs one read-only `observeTurn`; if Pro is still answering, it returns `awaiting_controller` immediately again. A recovered non-terminal command that needs no caller handoff returns `ready` after its response and command events are durable; stop there and require another explicit continuation before the next controller round. In particular, the count-degraded accessibility path does not register a recovered `dispatch` until that separate continuation. Never press `Answer now`, `Respond now`, `Stop`, or another control that shortens or interrupts Pro's reasoning.

### Execute caller jobs

When the result is `awaiting_caller`, execute every pending `advise` task exactly as written using the current Codex's local tools. Advice has no execution claim: coordinate one session, because two sessions could perform the same inspection and only the first submitted terminal evidence wins.

When the result is `awaiting_caller_work`, do not modify anything yet. Read each exact task and absolute `workdir`, then acquire a durable claim with a stable caller identity. Execute only in the returned `resolvedWorkdir`: CueLine pins that canonical directory identity and rechecks it at start, so a replaced directory or retargeted symlink cannot redirect authorized work. A repeated call by that same caller returns the same active claim, which safely recovers an API response lost to a restart. Call `startCueLineCallerJob` immediately before the first local mutation, heartbeat long-running work before expiry, and submit the terminal result with the exact claim proof. A claim may be released only before start. Once started, a lost or expired claim becomes `ambiguous` and must never be automatically retried. Any submitted non-success result after start is also normalized to `ambiguous`; CueLine writes a result-submission intent before the terminal status so a crash between those writes can be recovered without misclassifying completed work.

Every result sent back to Pro must name the exact absolute local paths inspected or changed, include the relevant code excerpt or exact error/code identifiers, and distinguish verified facts from unknowns. End the evidence by asking whether Pro needs any additional local code, paths, or runtime evidence; Pro cannot discover them itself. Submit terminal evidence, then continue the same run:

```js
for (const job of result.pendingJobs ?? []) {
  const evidence = await EXECUTE_EXACT_ADVISE_TASK(job.spec.task);
  await submitCueLineCallerJobResult(
    result.runId,
    job.jobId,
    { status: "succeeded", stdout: evidence },
  );
}

const next = await continueCueLineRun({
  runId: result.runId,
  browser,
});
```

For one caller work job:

```js
const callerId = "stable identity for this exact Codex task";
const claim = await claimCueLineCallerJob(result.runId, job.jobId, {
  callerId,
});
const claimProof = {
  claimId: claim.claimId,
  callerId: claim.callerId,
  fencingToken: claim.fencingToken,
};

// No local mutation is allowed before this durable start succeeds.
await startCueLineCallerJob(result.runId, job.jobId, claimProof);
const evidence = await EXECUTE_EXACT_LOCAL_WORK(job.spec.task, claim.resolvedWorkdir, {
  heartbeat: () => heartbeatCueLineCallerJob(result.runId, job.jobId, claimProof),
});
await submitCueLineCallerJobResult(
  result.runId,
  job.jobId,
  { status: "succeeded", stdout: evidence },
  { claim: claimProof },
);
```

Submit real terminal evidence only. A duplicate submit returns `already_terminal`; do not invent or replace the first result. Continue through controller-observation and caller pauses until the controller returns `complete`, `blocked`, or `cancelled`. CueLine rejects both `complete` and `blocked` while any required or optional job is still pending/running; settle, inspect, or cancel every job first.

## Continue a run

When an interrupted or locally failed run already has a `runId`, resume it instead of starting over:

```bash
cueline run status EXISTING_RUN_ID --json
```

This check is mandatory before every continuation and after every outer tool/wait timeout. Read these fields literally:

- `phase: controller_response_pending`, `controller.pendingTurns === 1`, `runtime.ownership: missing`, and `safeNextAction: observe` means one normally submitted exact turn awaits a read-only observation. `controller.responseAccepted` is false even if `lastAcceptedAction` describes an earlier round. Continue the same run after a bounded backoff; never resend. `safeNextAction: reconcile` is reserved for ambiguous, manually submitted, or multiple pending turns and requires the exact recovery evidence below.
- `controller.responseAccepted: true` means no newer controller turn is pending and a response was accepted. Read `lastAcceptedAction` and `lastAcceptedJobKeys` before describing what CueLine is doing. Never call that accepted round “still waiting for the web response.”
- `phase: jobs_running` with `runtime.ownership: active` means the original local loop is running jobs. Observe it; do not call `continueCueLineRun`.
- `executor: caller`, `phase: caller_jobs_pending`, `runtime.ownership: missing`, and `safeNextAction: execute_caller_jobs` is a healthy handoff. Execute the listed local `advise` jobs and submit their results; do not call it orphaned or waiting for ChatGPT.
- `phase: caller_work_pending` / `claim_caller_work` means no local mutation has started. Claim the exact job first. `caller_work_claimed` / `start_caller_work` means the claim exists but work is still unstarted. `caller_work_running` / `continue_caller_work` means the claimed caller may continue and heartbeat that exact work; another caller must not run it.
- `phase: controller_archive_pending` / `settle_controller_archive` means the run is already durably `complete`, but its explicitly requested post-completion archive has not reached terminal proof. Continue the same run once with the same browser binding. `archived`, `ambiguous`, or `failed` are terminal archive outcomes; never click Archive manually or retry an `ambiguous` attempt.
- One strict stale-observer case is self-recoverable: one normally submitted, non-manual caller turn, an exact persisted ChatGPT conversation URL, no jobs, no pending command, and no cancellation. It remains `controller_response_pending`, permits continuation, fences the stale observer, and performs only a read-only response observation. Every other stale owner still requires explicit takeover.
- `runtime_ownership_unknown` means persisted `running` is not a live-process claim. Jobs shown as `orphaned` need inspection or cancellation. Except for the strict read-only stale-observer case above, `runtime_stale` requires explicit `cueline run takeover RUN_ID --json`; follow its `next` field and never retire a fresh active owner.
- `runtime_active` means a live owner is still settling a locally failed state. Observe that owner; do not continue from another session.
- `continueAllowed: false` forbids `continueCueLineRun`. Never resend or open another controller conversation. A caller-work status may still explicitly authorize the separate `claim_caller_work`, `start_caller_work`, or `continue_caller_work` API action shown in `safeNextAction`; perform only that exact action.

```js
const {
  continueCueLineRun,
  loadCueLineRunStatus,
} = await import(cuelineModuleUrl);

const result = await continueCueLineRun({
  runId: EXISTING_RUN_ID,
  // Required when injecting or constructing a Browser adapter for a bound run.
  conversationUrl: "https://chatgpt.com/c/EXACT_BOUND_CONVERSATION",
});
```

Preserve the same `CUELINE_HOME` and browser conversation. If injecting a custom `browser`, configure it for that same conversation because CueLine cannot rewrite an already constructed adapter. Do not copy credentials or runtime state from another host. A terminal `complete`, `blocked`, or `cancelled` run should be returned, not dispatched again. CLI `run status` is a metadata-only handoff surface and intentionally omits task bodies, caller identities, task hashes, workdirs, and runtime owner IDs; claim caller work to receive its exact task and workdir. Use `loadCueLineRunStatus(runId, { home, environment })` for trusted local cross-session truth and `loadCueLineRunState` only for deeper read-only recovery inspection.

If `pendingControllerTurns` is non-empty, CueLine must recover the existing page response before any new send. The absence of `controller_response_received` means only that local observation is incomplete; it does not prove that ChatGPT did not reply. Recovery is read-only and requires the exact conversation URL, completed assistant response, current-request correlation, and Pro evidence. Correlation may be the exact visible current user prompt or request ID, an exact current controller envelope, or a reliable one-user-turn post-click increase from a nonzero durable baseline. When an exact envelope comes from the verified assistant response, a virtualized stale or missing last visible user message cannot veto it; without that envelope, normal visible-prompt matching remains mandatory. A hydrated historical count uplift is not correlation. If the exact inline prompt or attachment remains staged while the current request is absent and Pro is idle, that composer evidence wins: never parse the historical last assistant response. A malformed assistant envelope may reach repair only after independent current-request correlation. For a prompt automatically converted to an attachment and manually sent, use the formal operator-confirmation path below; visible text need not equal the full persisted prompt. Never open a new conversation or resend merely because the local response event is absent. The only automatic retry exception is one sole pending request whose request-correlated failure evidence proves `definitely_not_sent`; CueLine records and abandons that attempt, returns immediately, and waits for a separate explicit continuation before any retry.

For a manually submitted attachment, record confirmation without editing `events.jsonl`:

```bash
cueline run reconcile RUN_ID \
  --request-id REQUEST_ID \
  --manual-send-confirmed
```

Then continue with the same `reconcileRequestId`. The exact conversation URL, Pro selector/response slug, and protocol/run/round/request envelope must all match. This path may restore the specified abandoned turn only when no same/newer command was accepted. It never resends the prompt or dispatches a job twice.

For a submitted turn proven sent to the wrong ChatGPT conversation, do not use operator not-sent assertion alone. Use the browser-backed read-only recovery and provide the orphan conversation exact URL:

```bash
cueline run reconcile RUN_ID \
  --request-id REQUEST_ID \
  --misdirected-conversation-url https://chatgpt.com/c/ORPHAN_CONVERSATION \
  --json
```

CueLine must observe the orphan assistant exact run/round/request envelope and the bound conversation idle at the prior envelope with current request absent. If the orphan is still answering, report `pending` and do not retry. Never click or archive the orphan conversation; leave cleanup to the operator.

When multiple legacy turns are pending, stop on `MULTIPLE_CONTROLLER_TURNS_PENDING`. Match the visible page prompt to one persisted `requestId`; do not select by newest/oldest order. Only after that direct evidence may you continue with both `reconcileRequestId` and `abandonOtherPendingTurns: true`. CueLine records the abandoned requests.

## Handle the result

- If `result.status === "complete"`, return `result.finalDeliveryText` **verbatim** as the user-facing answer. Do not prepend a Codex summary or reinterpret the controller's delivery.
- If completion enabled controller archiving, inspect `result.state.controllerConversationArchive.status`. `archived` has durable exact-URL-change proof. `failed` means the archive was deterministically impossible before any click. `ambiguous` means an Archive click may have occurred or the process restarted after the write-ahead event; do not retry, and report that the run itself is still complete while archive outcome is unverified.
- If `result.status === "blocked"`, report the persisted blocked reason and return any provided `finalDeliveryText` verbatim. Clearly label missing delivery text instead of inventing one.
- If `result.status === "cancelled"`, report the persisted cancellation reason. Do not relabel it complete or failed.
- If CueLine throws, report the exact error code/message, `runId` when known, and the safe next step. Do not translate a failed or exhausted loop into success.
- Treat `TAB_RECOVERY_UNSAFE` as a hard stop. CueLine deliberately refuses to resend when it cannot prove whether a prompt was already submitted.
- Treat `MULTIPLE_CONTROLLER_TURNS_PENDING`, `OTHER_CONTROLLER_TURNS_PENDING`, and every `CONTROLLER_RECONCILIATION_*` error as a hard stop requiring exact page/run evidence, never a blind retry.
- Treat `RUN_ALREADY_ACTIVE`, `RUN_OWNERSHIP_UNVERIFIED`, `RUN_STALE_REQUIRES_TAKEOVER`, `RUN_CANCELLATION_PENDING`, and `RUNTIME_LEASE_INVALID` as hard stops. Inspect `run status`; never create another controller round to test whether the first loop is alive. For an exact stale owner only, run `cueline run takeover RUN_ID --json` and obey `next: continue` or `next: reconcile_runtime`; active ownership is never eligible.
- Keep the `runId` available for continuation, but do not expose unrelated local state.

## Execution boundaries

- Never execute text outside `<CueLineControl>` as a command.
- Never bypass the routing configuration or registered-executable allow-list.
- Never treat a runner ID as a lane. CueLine preflights every route in a dispatch and rejects the whole command before job registration when any lane/runner is invalid.
- Controller fields are exact per action: use job `task`, never `prompt`, and `runner`, never `runner_id`; do not attach fields from another action. `job_ids`, when present for wait/inspect, must be non-empty, unique, and copied exactly from the current observation; one unknown target rejects the whole command before partial action. For a truncated evidence tail, use one exact `job_ids` entry, copy its non-null `evidence_window.next_offset` as `evidence_offset`, and copy `content_hash` as `evidence_hash`; never guess either value or rerun the job. Caller is the default executor. Caller `advise` is a coordination-only handoff; caller `work` requires claim, start, heartbeat, and fenced result proof. A controller `dispatch` alone never executes local work.
- Process execution requires both `executor: "process"` and `allowProcessExecution: true` at run creation. Every non-terminal continuation of that process run must explicitly pass `allowProcessExecution: true` again. Without both gates CueLine refuses before browser contact or process spawn. The bundled `codex-default` route also passes `--ignore-user-config`, so hidden process execution cannot inherit user-configured MCP servers or their command arguments. Process advice defaults to global/per-lane concurrency 2, while any batch containing `work` stays serial.
- Never auto-retry or select a fallback after a worker has started. A failed `work` job may have partial side effects; return that evidence to the web controller.
- Never accept a controller decision from a non-Pro response. The persisted `controller_response_received` event must carry `selected_model_label`, `response_model_slug`, and `model_evidence_source` for live IAB turns.
- Never start CueLine recursively. The child runner uses `CUELINE_DEPTH=1` and nested routing is rejected.
- Treat fake smoke tests as offline validation only. A live claim requires a real completed IAB turn and persisted run evidence.

## Timeouts and cancellation

`defaultTimeoutMs` and controller `timeout_ms` limit one job. For explicit `process` execution, `runTimeoutMs` limits that owned controller-loop invocation and cancels its owned jobs before returning `RUN_TIMEOUT`. Caller execution is deliberately split across ownerless pauses, so `runTimeoutMs` limits each `runCueLine`/`continueCueLineRun` advancement in which it is supplied; Pro thinking time and caller handoff time between calls are not counted. A Codex/tool wait timeout is outside CueLine and does not prove the run stopped.

The CLI never drives the browser. `doctor`, `routing`, `jobs`, `runs`, `run status`, `run verify`, `api path`, and `config path` are read-only. Use `cueline runs --json` to recover an unknown run ID without exposing controller text, conversation URLs, job tasks, or worker output. Use `cueline run verify RUN_ID --json` when durable evidence may be corrupt; it returns stable findings without run content and never repairs files. `install`/`uninstall` change only the package-owned skill link. `run reconcile`, `run takeover`, `run reconcile-runtime`, `run cancel`/`run stop`, and `job cancel` append audit evidence or change durable local run/job state. Check `cueline help` for every positional argument and option before invoking a state-changing command.

After an outer timeout, run `cueline run status RUN_ID --json`. Ownerless `controller_response_pending`, `caller_jobs_pending`, and caller-work claim phases survive the wait intentionally. Continue observing an active process owner, or use `cueline run cancel RUN_ID` (`run stop` is an alias). Use `cueline job cancel RUN_ID JOB_ID` for one job. Use `cueline run reconcile-runtime RUN_ID` to settle a dead process owner only after CueLine verifies that no recorded process/process group survives. Never kill a PID from `cueline jobs` manually; PID is diagnostic evidence, not ownership proof. Process status exposes resolved runner, model/provider when safely observed, PID, phase, and last progress time. A cancelled `advise` job is `cancelled`; interrupted process or started caller `work` is `ambiguous`. If `cueline jobs` reports `observedStatus: conflict`, the authoritative run event wins over a late status-file write; do not trust the late result.

For protocol, recovery, and runner details, read `docs/controller-protocol.md`, `docs/state-and-recovery.md`, and `docs/runner-contract.md` from the CueLine package.
