# Compatibility

## Runtime matrix

| Surface | v0.1 status | Notes |
|---|---|---|
| Node.js 22+ ESM | Supported | Core protocol, state, router, runners, fake browser tests |
| Codex Node REPL + built-in Browser (IAB) | Required for live control | Provides the imported API with the authenticated ChatGPT tab/browser client |
| Current Codex caller | Default local executor | Performs caller `advise`; caller `work` requires durable claim/start/heartbeat/result proof |
| `codex` CLI | Required only by bundled process route | Double authorization plus `--ignore-user-config`; auth remains under `CODEX_HOME`, user MCP config is not loaded |
| ChatGPT web conversation | Supported, text commands | Controller has no direct local tools; CueLine requires a Pro composer and Pro response slug |
| macOS | Primary supported desktop | Codex desktop + symlink installer target |
| Linux | Core/CI target | Live Codex IAB availability depends on the host product |
| Windows | Not verified | `install.sh` and symlink layout are not a Windows installer |

The npm package has no runtime dependencies. Development requires TypeScript and Node type definitions from `devDependencies`.

## ChatGPT requirements

CueLine is designed for a conversation already authenticated by the user at `chatgpt.com`. CueLine neither handles credentials nor verifies plan entitlement. Before each controller turn it may switch the composer to `Pro`; that is its only automatic model switch. It also requires Pro evidence on the completed response.

The v0.1 adapter relies on accessible textbox/button roles, attachment chips, and assistant-message markup in the current ChatGPT web UI. ChatGPT's automatic conversion of a long filled prompt into an attachment is supported. Deliberate file upload is not. UI changes can cause explicit `COMPOSER_MISSING`, `SEND_BUTTON_MISSING`, or response-timeout errors. A fake adapter test cannot prove that the current live page still matches.

## Supported in v0.1

- one ChatGPT conversation per run
- text controller observations and commands
- `dispatch`, `wait`, `inspect`, `complete`, and `blocked`
- foreground and background local jobs
- caller-first execution: durable `advise` handoff plus fenced caller `work` claim/start/heartbeat/result APIs
- durable built-in-IAB submit/one-shot-observe pauses that let Pro think beyond one outer tool waiter without resending
- double-authorized process execution with default global/per-lane concurrency of two and serialized batches containing `work`
- deterministic routing before spawn
- append-only run recovery and atomic snapshots
- continuation by run ID and stored conversation URL
- read-only persisted-state loading through `loadCueLineRunState`
- cross-session run status, runtime ownership, run/job cancellation, and optional run deadlines
- automatic long-text attachment recognition, one-click ambiguous-send safety, and operator-confirmed manual reconciliation
- inspect-prioritized bounded controller evidence (successful stdout preferred; full stdout/stderr retained locally)
- process status with resolved runner, PID, phase, last progress, and safely observed model/provider
- injected fake browser/runner for offline tests

## Not supported in v0.1

- model switching other than CueLine selecting `Pro`
- images, screenshots as controller input, audio, or binary payloads
- file upload/download through the ChatGPT page
- Deep Research, Projects, Apps, or custom GPT UI flows
- multiple simultaneous controller conversations for one run
- direct browser-to-local tool calls
- automatic retry/fallback after a worker starts
- cross-host transfer of browser sessions, credentials, child processes, or local runtime state
- unattended guarantee across ChatGPT UI or authentication changes

## CLI boundary

`cueline doctor`, `routing`, `jobs`, `run status`, `api path`, and `config path` are read-only. `install`/`uninstall` change only the package-owned skill link. `run reconcile`, `run takeover`, `run reconcile-runtime`, `run cancel` / `run stop`, and `job cancel` append audit evidence or change local durable state; `cueline help` lists their exact positional syntax and options. None drives the ChatGPT page. `run reconcile --manual-send-confirmed --conversation-url URL` can atomically bind the first exact URL created by a manual send; the imported API still performs identity/Pro reconciliation through Codex's IAB browser object. `run takeover` retires only an exact stale owner/heartbeat and refuses a fresh active owner; every process run is directed through `reconcile-runtime` before continuation.

## Live readiness checklist

1. `node --version` reports 22 or newer.
2. `npm run build` succeeds for a checkout, or the installed package contains `dist/`.
3. Codex exposes its built-in Browser runtime.
4. A logged-in `https://chatgpt.com/` tab is open and the intended model/conversation is selected.
5. `cueline doctor` reports `caller_ready yes` and at least one enabled caller lane. `process_available_lanes` may be zero without degrading caller mode; explicit process mode additionally requires `codex-default` (or a configured alternative) to be available.
6. A live smoke completes one harmless controller round and one caller `advise` result handoff before any caller claim or explicit process work is considered.

Readiness does not prove a worker will succeed. Preserve the run evidence and report the exact missing prerequisite when a step fails.
