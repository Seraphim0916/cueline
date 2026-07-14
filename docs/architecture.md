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

`src/browser/codex-iab/` implements a text-only adapter over Codex's IAB client. It claims an existing ChatGPT tab when possible, otherwise opens the requested ChatGPT URL. It fills the composer, emits durable pre-click and post-click checkpoints, sends one turn, waits for a stable completed assistant message, and records the resulting conversation URL. Its recovery path is read-only: it imports an existing response only when the exact last user prompt matches the persisted pending turn and both Pro model checks pass.

The adapter can receive an injected browser or resolve `globalThis.iab` / `agent.browsers.get("iab")` from Codex's runtime. Plain Node does not provide these globals.

### Controller protocol

`src/protocol/` extracts the last complete `<CueLineControl>` envelope and validates it against the exact pending `run_id`, `round`, and `request_id`. Invalid output is returned to the same controller for a bounded repair attempt. This rejects stale replies and unrelated JSON from earlier parts of a conversation.

### Controller loop

`src/core/controller-loop.ts` owns the run:

1. Persist the intended controller turn.
2. Persist browser submission checkpoints around the send boundary.
3. Send an observation through the browser adapter.
4. Persist the assistant response.
5. Validate protocol identity and every pre-spawn route, then persist the accepted command.
6. Execute the command through the local supervisor.
7. Snapshot the derived state.
8. Repeat until `complete`, `blocked`, or the round limit is reached.

The default limits are 12 controller rounds and two repair attempts per pending command.

### Routing and runners

`src/router/` chooses an enabled, available candidate before any process starts. `src/runners/` requires an explicitly registered `argv[0]`, uses `spawn` with `shell: false`, and never performs post-spawn fallback. `src/jobs/` coordinates foreground/background execution and persists job status.

### Durable state

`src/state/` writes a per-run JSONL event log and an atomic materialized snapshot. The event log is authoritative; a snapshot is a replay optimization. Pending controller turns and request-correlated browser failure evidence survive replay. A prompt is retried only when the exact sole pending request is proven `definitely_not_sent`; ambiguous submissions require read-only reconciliation. Job status files are atomically replaced.

## Authority and trust

The controller can request local work, but a request is not equivalent to process access. CueLine applies these gates:

- exact run/round/request identity
- structurally valid command and unique `job_key`
- configured lane and pre-spawn candidate availability
- config-derived registered executable allow-list
- no shell interpolation
- deterministic job identity and duplicate-dispatch suppression
- no nested CueLine routing (`CUELINE_DEPTH`)
- no retry after a worker has started

These gates reduce accidental execution ambiguity; they do not make an allowed worker harmless. The local Codex/operator environment remains responsible for filesystem, network, credential, and side-effect permissions granted to each registered executable.

## Data flow

1. The original user request becomes part of every controller observation.
2. Job outputs and errors are stored locally and included in later observations (individual fields are bounded before browser submission).
3. ChatGPT returns a command; only the control envelope is machine-executed.
4. On `complete`, CueLine returns `final_delivery_text` to Codex.
5. On `blocked`, CueLine preserves the controller's reason and optional delivery text.

CueLine does not intentionally inspect or export cookies, tokens, environment secrets, or browser session material. The IAB uses the user's already authenticated page.

## Dependency model

The published JavaScript has zero runtime npm dependencies and uses Node built-ins. TypeScript and Node type definitions are development dependencies only. Live ChatGPT orchestration additionally depends on Codex's IAB runtime and ChatGPT's current web UI; the bundled default local route also expects the `codex` CLI on `PATH`. The core state, protocol, router, and fake tests run in plain Node.
