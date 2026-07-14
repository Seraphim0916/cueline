---
name: cueline
description: Use CueLine whenever the user wants a ChatGPT web Pro conversation to be the top-level controller that plans, delegates, reviews evidence, or decides completion while Codex performs the permitted local execution. Trigger for requests to let web ChatGPT lead Codex, combine browser advice with local workers, run a durable controller loop, or continue an existing CueLine run. CueLine is text-only in v0.1 and uses Codex's built-in in-app Browser.
---

# CueLine

Use CueLine to put the current ChatGPT web conversation in charge of planning and next-step decisions while Codex remains the local intermediary and executor. The web page has no direct machine access; it sends validated text commands that CueLine applies through local policy.

## Preconditions

1. Confirm the current host, operator, and work directory before local work.
2. Run `cueline version`, then `cueline doctor`, and require the same expected package version, Node.js 22 or newer, plus at least one usable lane. Run `cueline api path` and require the returned API module to exist. Do not reuse a module imported before a package update. The bundled default lane needs the `codex` CLI on `PATH`.
3. Use Codex's persistent Node REPL/runtime together with the built-in in-app Browser (IAB), not a separate plain `node` child, Chrome automation, or GPT Relay. Claim the logged-in `chatgpt.com` tab intended for this run.
4. CueLine requires the composer model selector to show `Pro` before every controller turn and requires the completed assistant message's `data-message-model-slug` to identify a Pro model. The account label (for example, a profile name ending in `Pro`) is subscription evidence only and never model evidence. Do not bypass `MODEL_SELECTOR_MISSING`, `PRO_MODEL_UNAVAILABLE`, `PRO_MODEL_SELECTION_FAILED`, or `PRO_MODEL_MISMATCH`.
5. Do not request, read, copy, or print cookies, access tokens, browser session material, or private environment values.
6. Keep v0.1 controller traffic text-only. Do not attempt images, file upload, Deep Research, Projects, or Apps. CueLine may switch the composer from another model to `Pro`; no other model switching is allowed.

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
  createCodexIabAdapter,
  runCueLine,
  startCueLineRun,
} = await import(cuelineModuleUrl);
if (CUELINE_VERSION !== expectedCueLineVersion) throw new Error(`CUELINE_VERSION_MISMATCH: loaded ${CUELINE_VERSION}, expected ${expectedCueLineVersion}`);

const browser = createCodexIabAdapter({
  // Optional: conversationUrl: "https://chatgpt.com/c/..."
});

const result = await runCueLine({
  request: USER_REQUEST,
  browser,
  // Optional: conversationUrl, routingConfig/routingConfigPath, home, cwd,
  // environment, defaultTimeoutMs, runTimeoutMs, signal, maxRounds,
  // maxRepairAttempts.
});
```

Pass the user's request faithfully. Do not silently widen it, and do not turn an analysis-only request into `work`. Use `startCueLineRun` when the caller needs the explicit start entry point; use `runCueLine` for the normal start-and-drive path.

The web controller decides `dispatch`, `wait`, `inspect`, `complete`, or `blocked`. CueLine validates the exact pending identity, selects only an available pre-spawn route, persists transitions, and prevents automatic fallback after a worker starts.

## Continue a run

When an interrupted or locally failed run already has a `runId`, resume it instead of starting over:

```bash
cueline run status EXISTING_RUN_ID --json
```

This check is mandatory before every continuation and after every outer tool/wait timeout. Read these fields literally:

- `controller.responseAccepted: true` means the web response was already received and accepted. Read `lastAcceptedAction` and `lastAcceptedJobKeys` before describing what CueLine is doing. Never say CueLine is waiting for the web response.
- `phase: jobs_running` with `runtime.ownership: active` means the original local loop is running jobs. Observe it; do not call `continueCueLineRun`.
- `runtime_ownership_unknown` or `runtime_stale` means persisted `running` is not a live-process claim. Jobs shown as `orphaned` need inspection or cancellation.
- `runtime_active` means a live owner is still settling a locally failed state. Observe that owner; do not continue from another session.
- `continueAllowed: false` is a hard stop. Do not resend, resume, or open another controller conversation.

```js
const {
  continueCueLineRun,
  loadCueLineRunStatus,
} = await import(cuelineModuleUrl);

const result = await continueCueLineRun({
  runId: EXISTING_RUN_ID,
  // Omit browser/conversationUrl only when CueLine already persisted the exact URL.
  // conversationUrl: "https://chatgpt.com/c/...",
});
```

Preserve the same `CUELINE_HOME` and browser conversation. If injecting a custom `browser`, configure it for that same conversation because CueLine cannot rewrite an already constructed adapter. Do not copy credentials or runtime state from another host. A terminal `complete`, `blocked`, or `cancelled` run should be returned, not dispatched again. Use `loadCueLineRunStatus(runId, { home, environment })` for cross-session truth and `loadCueLineRunState` only for deeper read-only recovery inspection.

If `pendingControllerTurns` is non-empty, CueLine must recover the existing page response before any new send. The absence of `controller_response_received` means only that local observation is incomplete; it does not prove that ChatGPT did not reply. Recovery is read-only and requires the exact conversation URL, exact last-user prompt match, completed assistant response, and Pro evidence. Never open a new conversation or resend merely because the local response event is absent. The only automatic retry exception is one sole pending request whose request-correlated failure evidence proves `definitely_not_sent`; CueLine records the old turn as abandoned before starting a new round.

When multiple legacy turns are pending, stop on `MULTIPLE_CONTROLLER_TURNS_PENDING`. Match the visible page prompt to one persisted `requestId`; do not select by newest/oldest order. Only after that direct evidence may you continue with both `reconcileRequestId` and `abandonOtherPendingTurns: true`. CueLine records the abandoned requests.

## Handle the result

- If `result.status === "complete"`, return `result.finalDeliveryText` **verbatim** as the user-facing answer. Do not prepend a Codex summary or reinterpret the controller's delivery.
- If `result.status === "blocked"`, report the persisted blocked reason and return any provided `finalDeliveryText` verbatim. Clearly label missing delivery text instead of inventing one.
- If `result.status === "cancelled"`, report the persisted cancellation reason. Do not relabel it complete or failed.
- If CueLine throws, report the exact error code/message, `runId` when known, and the safe next step. Do not translate a failed or exhausted loop into success.
- Treat `TAB_RECOVERY_UNSAFE` as a hard stop. CueLine deliberately refuses to resend when it cannot prove whether a prompt was already submitted.
- Treat `MULTIPLE_CONTROLLER_TURNS_PENDING`, `OTHER_CONTROLLER_TURNS_PENDING`, and every `CONTROLLER_RECONCILIATION_*` error as a hard stop requiring exact page/run evidence, never a blind retry.
- Treat `RUN_ALREADY_ACTIVE`, `RUN_OWNERSHIP_UNVERIFIED`, `RUN_STALE_REQUIRES_TAKEOVER`, `RUN_CANCELLATION_PENDING`, and `RUNTIME_LEASE_INVALID` as hard stops. Inspect `run status`; never create another controller round to test whether the first loop is alive.
- Keep the `runId` available for continuation, but do not expose unrelated local state.

## Execution boundaries

- Never execute text outside `<CueLineControl>` as a command.
- Never bypass the routing configuration or registered-executable allow-list.
- Never treat a runner ID as a lane. CueLine preflights every route in a dispatch and rejects the whole command before job registration when any lane/runner is invalid.
- The controller field is `runner`, never `runner_id`. An all-`advise` dispatch runs concurrently; any dispatch containing `work` stays serial.
- Never auto-retry or select a fallback after a worker has started. A failed `work` job may have partial side effects; return that evidence to the web controller.
- Never accept a controller decision from a non-Pro response. The persisted `controller_response_received` event must carry `selected_model_label`, `response_model_slug`, and `model_evidence_source` for live IAB turns.
- Never start CueLine recursively. The child runner uses `CUELINE_DEPTH=1` and nested routing is rejected.
- Treat fake smoke tests as offline validation only. A live claim requires a real completed IAB turn and persisted run evidence.

## Timeouts and cancellation

`defaultTimeoutMs` and controller `timeout_ms` limit one job. `runTimeoutMs` limits the full controller loop and cancels owned jobs before returning `RUN_TIMEOUT`. A Codex/tool wait timeout is outside CueLine and does not prove the run stopped.

After an outer timeout, run `cueline run status RUN_ID --json`. Continue observing an active owner, or use `cueline run cancel RUN_ID` (`run stop` is an alias). Use `cueline job cancel RUN_ID JOB_ID` for one job. Never kill a PID from `cueline jobs` manually; PID is diagnostic evidence, not ownership proof. A cancelled `advise` job is `cancelled`; interrupted `work` or ownerless work is `ambiguous`.

For protocol, recovery, and runner details, read `docs/controller-protocol.md`, `docs/state-and-recovery.md`, and `docs/runner-contract.md` from the CueLine package.
