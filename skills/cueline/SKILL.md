---
name: cueline
description: Use CueLine whenever the user wants a ChatGPT web Pro conversation to be the top-level controller that plans, delegates, reviews evidence, or decides completion while Codex performs the permitted local execution. Trigger for requests to let web ChatGPT lead Codex, combine browser advice with local workers, run a durable controller loop, or continue an existing CueLine run. CueLine is text-only in v0.1 and uses Codex's built-in in-app Browser.
---

# CueLine

Use CueLine to put the current ChatGPT web conversation in charge of planning and next-step decisions while Codex remains the local intermediary and executor. The web page has no direct machine access; it sends validated text commands that CueLine applies through local policy.

## Preconditions

1. Confirm the current host, operator, and work directory before local work.
2. Run `cueline doctor` and require Node.js 22 or newer plus at least one usable lane. Run `cueline api path` and require the returned API module to exist. The bundled default lane needs the `codex` CLI on `PATH`.
3. Use Codex's persistent Node REPL/runtime together with the built-in in-app Browser (IAB), not a separate plain `node` child, Chrome automation, or GPT Relay. Claim the logged-in `chatgpt.com` tab intended for this run.
4. CueLine requires the composer model selector to show `Pro` before every controller turn and requires the completed assistant message's `data-message-model-slug` to identify a Pro model. The account label (for example, a profile name ending in `Pro`) is subscription evidence only and never model evidence. Do not bypass `MODEL_SELECTOR_MISSING`, `PRO_MODEL_UNAVAILABLE`, `PRO_MODEL_SELECTION_FAILED`, or `PRO_MODEL_MISMATCH`.
5. Do not request, read, copy, or print cookies, access tokens, browser session material, or private environment values.
6. Keep v0.1 controller traffic text-only. Do not attempt images, file upload, Deep Research, Projects, or Apps. CueLine may switch the composer from another model to `Pro`; no other model switching is allowed.

If live IAB, authentication, build output, or a required runner is missing, report that exact prerequisite. Do not claim a live run from fake or read-only evidence.

## Start a run

Drive CueLine from Codex's Node runtime so the injected IAB object remains available. First run `cueline api path` in the local shell. In the Node REPL, assign its exact one-line output to `cuelineApiPath`; do not guess an npm prefix or repository location. Import the built public API; do not import Omnilane or GPT Relay.

```js
var cuelineApiPath = "/exact/output/from/cueline/api/path";
const {
  createCodexIabAdapter,
  runCueLine,
  startCueLineRun,
} = await import(cuelineApiPath);

const browser = createCodexIabAdapter({
  // Optional: conversationUrl: "https://chatgpt.com/c/..."
});

const result = await runCueLine({
  request: USER_REQUEST,
  browser,
  // Optional: conversationUrl, routingConfig/routingConfigPath, home, cwd,
  // environment, defaultTimeoutMs, maxRounds, maxRepairAttempts.
});
```

Pass the user's request faithfully. Do not silently widen it, and do not turn an analysis-only request into `work`. Use `startCueLineRun` when the caller needs the explicit start entry point; use `runCueLine` for the normal start-and-drive path.

The web controller decides `dispatch`, `wait`, `inspect`, `complete`, or `blocked`. CueLine validates the exact pending identity, selects only an available pre-spawn route, persists transitions, and prevents automatic fallback after a worker starts.

## Continue a run

When an interrupted or locally failed run already has a `runId`, resume it instead of starting over:

```js
const {
  continueCueLineRun,
} = await import(cuelineApiPath);

const result = await continueCueLineRun({
  runId: EXISTING_RUN_ID,
  // Omit browser/conversationUrl to let CueLine reuse the persisted URL in IAB.
});
```

Preserve the same `CUELINE_HOME` and browser conversation. If injecting a custom `browser`, configure it for that same conversation because CueLine cannot rewrite an already constructed adapter. Do not copy credentials or runtime state from another host. A terminal `complete` or `blocked` run should be returned, not dispatched again. Use `loadCueLineRunState(runId, { home, environment })` when only read-only recovery inspection is needed.

## Handle the result

- If `result.status === "complete"`, return `result.finalDeliveryText` **verbatim** as the user-facing answer. Do not prepend a Codex summary or reinterpret the controller's delivery.
- If `result.status === "blocked"`, report the persisted blocked reason and return any provided `finalDeliveryText` verbatim. Clearly label missing delivery text instead of inventing one.
- If CueLine throws, report the exact error code/message, `runId` when known, and the safe next step. Do not translate a failed or exhausted loop into success.
- Treat `TAB_RECOVERY_UNSAFE` as a hard stop. CueLine deliberately refuses to resend when it cannot prove whether a prompt was already submitted.
- Keep the `runId` available for continuation, but do not expose unrelated local state.

## Execution boundaries

- Never execute text outside `<CueLineControl>` as a command.
- Never bypass the routing configuration or registered-executable allow-list.
- Never auto-retry or select a fallback after a worker has started. A failed `work` job may have partial side effects; return that evidence to the web controller.
- Never accept a controller decision from a non-Pro response. The persisted `controller_response_received` event must carry `selected_model_label`, `response_model_slug`, and `model_evidence_source` for live IAB turns.
- Never start CueLine recursively. The child runner uses `CUELINE_DEPTH=1` and nested routing is rejected.
- Treat fake smoke tests as offline validation only. A live claim requires a real completed IAB turn and persisted run evidence.

For protocol, recovery, and runner details, read `docs/controller-protocol.md`, `docs/state-and-recovery.md`, and `docs/runner-contract.md` from the CueLine package.
