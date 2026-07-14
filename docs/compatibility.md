# Compatibility

## Runtime matrix

| Surface | v0.1 status | Notes |
|---|---|---|
| Node.js 22+ ESM | Supported | Core protocol, state, router, runners, fake browser tests |
| Codex Node REPL + built-in Browser (IAB) | Required for live control | Provides the imported API with the authenticated ChatGPT tab/browser client |
| `codex` CLI | Required by default route | Custom routing may register a different executable |
| ChatGPT web conversation | Supported, text only | Uses the model currently selected in the page |
| macOS | Primary supported desktop | Codex desktop + symlink installer target |
| Linux | Core/CI target | Live Codex IAB availability depends on the host product |
| Windows | Not verified | `install.sh` and symlink layout are not a Windows installer |

The npm package has no runtime dependencies. Development requires TypeScript and Node type definitions from `devDependencies`.

## ChatGPT requirements

CueLine is designed for a conversation already authenticated by the user at `chatgpt.com`, including a ChatGPT Pro account when Pro is the intended controller. CueLine neither handles credentials nor verifies plan entitlement. It does not switch models; the page's current selection is authoritative.

The v0.1 adapter relies on accessible textbox/button roles and assistant-message markup in the current ChatGPT web UI. UI changes can cause explicit `COMPOSER_MISSING`, `SEND_BUTTON_MISSING`, or response-timeout errors. A fake adapter test cannot prove that the current live page still matches.

## Supported in v0.1

- one ChatGPT conversation per run
- text controller observations and commands
- `dispatch`, `wait`, `inspect`, `complete`, and `blocked`
- foreground and background local jobs
- concurrent all-`advise` batches and serialized batches containing `work`
- deterministic routing before spawn
- append-only run recovery and atomic snapshots
- continuation by run ID and stored conversation URL
- read-only persisted-state loading through `loadCueLineRunState`
- cross-session run status, runtime ownership, run/job cancellation, and optional run deadlines
- injected fake browser/runner for offline tests

## Not supported in v0.1

- automatic model selection or switching in ChatGPT
- images, screenshots as controller input, audio, or binary payloads
- file upload/download through the ChatGPT page
- Deep Research, Projects, Apps, or custom GPT UI flows
- multiple simultaneous controller conversations for one run
- direct browser-to-local tool calls
- automatic retry/fallback after a worker starts
- cross-host transfer of browser sessions, credentials, child processes, or local runtime state
- unattended guarantee across ChatGPT UI or authentication changes

## CLI boundary

`cueline doctor`, `routing`, `jobs`, `run status`, `run cancel` / `run stop`, `job cancel`, and `config path` diagnose or control the local runtime state. They do not drive the ChatGPT page. Live orchestration is an imported API run inside Codex so that the IAB browser object can be injected or resolved.

## Live readiness checklist

1. `node --version` reports 22 or newer.
2. `npm run build` succeeds for a checkout, or the installed package contains `dist/`.
3. Codex exposes its built-in Browser runtime.
4. A logged-in `https://chatgpt.com/` tab is open and the intended model/conversation is selected.
5. `cueline doctor` reports a readable routing config and `codex-default` (or a configured alternative) as available.
6. A text-only live smoke completes one harmless controller round before using `work` mode.

Readiness does not prove a worker will succeed. Preserve the run evidence and report the exact missing prerequisite when a step fails.
