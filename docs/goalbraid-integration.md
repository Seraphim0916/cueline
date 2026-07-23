# Goalbraid integration

CueLine can provide one bounded ChatGPT Pro decision at a Goalbraid turning point. It is a consultant, not the executor or completion authority.

```text
Goalbraid request -> CueLine / ChatGPT Pro advice -> Goalbraid validation
                                                       |
                                                       v
                                              Omnilane execution
                                                       |
                                                       v
                                              Goalbraid acceptance
```

## Preconditions

- Goalbraid returned `driver.stop_reason: awaiting_controller` and an absolute `driver.controller_handoff.request_path`.
- `cueline doctor --json` reports `status: ok` and `caller.ready: true`.
- The code runs inside Codex's persistent Node runtime with the in-app Browser; a plain Node subprocess cannot drive ChatGPT.
- The selected ChatGPT conversation can use Pro.

## Public API

Import the absolute module printed by `cueline api path`:

```js
const api = await import("file:///absolute/path/to/dist/src/api.js");
const browser = api.createCodexIabAdapter({ browser: globalThis.browser });

let bridge = await api.runGoalbraidDecision({
  requestPath: "/absolute/path/to/handoff/requests/gbd-....json",
  browser,
});

while (bridge.outcome === "awaiting_controller") {
  await boundedWaitWithoutResend();
  bridge = await api.continueGoalbraidDecision({
    requestPath: "/absolute/path/to/handoff/requests/gbd-....json",
    runId: bridge.cueline.runId,
    browser,
  });
}

if (bridge.published) {
  console.log(bridge.responsePath);
}
```

After publication, rerun the same Goalbraid command. Goalbraid independently checks the request ID, canonical snapshot digest, CueLine completion/integrity evidence, and closed decision set before it allows Omnilane to execute.

## Safety behavior

- ChatGPT is instructed to issue `complete` directly and never `dispatch`, `wait`, or `inspect`.
- A dispatch attempt raises `GOALBRAID_DECISION_DISPATCH_REJECTED`; no Goalbraid response is written.
- `blocked`, `cancelled`, pending, degraded, malformed, stale, or out-of-set results publish nothing.
- The public response publisher reloads the exact request and independently requires the matching CueLine run ID and prompt, caller-only execution, and process execution disabled. Calling the lower-level API cannot bypass those checks.
- The response is immutable and owner-only. An identical retry is idempotent; conflicting evidence is rejected.
- CueLine `complete` means only that the consultation finished. Goalbraid alone owns the project goal's final state.
