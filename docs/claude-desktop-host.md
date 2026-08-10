# Driving CueLine from Claude Code Desktop

CueLine's controller logic is unchanged in this lane. Only the transport differs:
where the Codex runtime injects a browser object directly, a Claude Code host
answers browser requests through a directory.

```
CueLine (Node)                      bridge dir                 Claude Code host
  createFileBridgeTools  ── writes ─▶ requests/<id>.json ── rename ─▶ inflight/<id>.json
  createClaudeDesktopIabBrowser ◀─ reads ── responses/<id>.json ◀── acts, writes
  createCodexIabAdapter  (unchanged codex-iab logic)
```

## Wiring

```ts
import { createClaudeDesktopIabBrowser } from "../browser/claude-desktop/iab-shim.js";
import { createFileBridgeTools } from "../browser/claude-desktop/file-bridge.js";
import { createNodeFileBridgeFs } from "../browser/claude-desktop/node-file-bridge-fs.js";
import { createCodexIabAdapter } from "../browser/codex-iab/chatgpt-client.js";

const tools = createFileBridgeTools({
  root: "/path/to/host-bridge",
  fs: createNodeFileBridgeFs(),
});
const browser = createClaudeDesktopIabBrowser({ tools });
const adapter = createCodexIabAdapter({ browser, conversationUrl });
```

The npm package keeps these transport modules internal rather than widening the
JavaScript API. Installed users operate the lane through the packaged
`cueline-claude-desktop-lane` and `cueline-claude-desktop-mailbox` binaries.
Source checkouts may still import the in-tree modules directly for development.

## The host agent's job

The normal host loop uses the bounded mailbox helper rather than hand-editing
four phase files:

```bash
cueline-claude-desktop-mailbox claim "$CUELINE_HOST_BRIDGE"
printf '%s' '<response-json>' | cueline-claude-desktop-mailbox respond \
  "$CUELINE_HOST_BRIDGE" '<request-id>'
```

`claim` waits, atomically claims one request, and persists `action_started`.
`respond` persists `action_completed` and `response_published` around the
partial-to-final response rename. Keeping filesystem work to those two commands
keeps Claude-hosted page probes inside the lane's 120-second composer-ready
window. The previous real Claude Desktop run measured
about 41 seconds for that probe. The 120-second composer window preserves margin
for repeated stability reads. Browser host operations retain a 180-second
ceiling; shared defaults remain 30 seconds for composer readiness and 10 seconds
per Browser operation.

Launch `cueline-claude-desktop-lane daemon ...` with Claude Code Desktop's
shell-tool **Run in background** mode. Do not combine shell `&`, `disown`, or
`nohup` with harness backgrounding, and never restart solely because the launch
tool call returned; that can leave two controller daemons sharing one mailbox.

Claim with an atomic rename from `requests/<id>.json` to
`inflight/<id>.json`; never use read-then-delete. Persist the original request,
ISO-8601 `updatedAt`, and these phases with atomic rewrites:

1. `claimed`
2. `action_started` immediately before the browser tool call
3. `action_completed` immediately after it returns
4. `response_published` after writing the response partial and before its final rename

CueLine removes request, inflight, and response only after reading the final response.
If the host dies, inflight evidence remains and a side-effecting action is reported as
`HOST_BRIDGE_ACTION_OUTCOME_UNKNOWN` rather than guessed to be unsent.

<!-- Legacy read-delete protocol retained only as historical context.

Loop: read the oldest file in `requests/`, **delete it**, perform **exactly** the
one action it names, write `responses/<id>.json`, repeat.

Deleting before acting is what makes the request at-most-once. A host that acts
first and deletes afterwards will re-read the same request on its next poll and
run the action twice — measured, not hypothetical — and for `clickRef` on the
send button that means submitting the prompt twice. If the host dies between the
delete and the response, CueLine times out: loud and recoverable, unlike a
duplicate submission.

Response shape:

```json
{ "id": "<same id>", "ok": true,  "result": <raw value> }
{ "id": "<same id>", "ok": false, "error": { "code": "HOST_TAB_CLOSED", "message": "..." } }
```

Write to `<path>.partial` and rename into place, so CueLine never reads a
half-written file.

-->

### Methods

| `method` | `params` | Tool | `result` |
|---|---|---|---|
| `listTabs` | — | tab listing | `[{tabId, url, title?}]` |
| `activeTab` | — | tab listing | `{tabId, url, title?}` or `null` |
| `newTab` | `{url}` | new tab; the shim supplies `https://chatgpt.com/` | `{tabId, url}` |
| `navigate` | `{tabId, url}` | navigate | `null` |
| `tabUrl` | `{tabId}` | **`javascript_exec` returning `location.href`** | the URL string |
| `tabTitle` | `{tabId}` | `javascript_exec` returning `document.title` | the title string |
| `evaluate` | `{tabId, source}` | `javascript_exec` | the completion value, verbatim |
| `readPage` | `{tabId, interactiveOnly}` | `read_page` | the tree text, verbatim |
| `clickRef` | `{tabId, ref}` | `computer` `left_click` with `ref` | `null` |

For `evaluate`, return a tagged envelope when the host tool transports text:

```json
{ "protocol": "cueline.evaluate-result/1", "encoding": "literal", "value": "{\"a\":1}" }
{ "protocol": "cueline.evaluate-result/1", "encoding": "json", "value": "{\"a\":1}" }
```

`literal` means the page returned a string. `json` means a non-string result was
serialized by the host transport. Never infer encoding from `{` or `[`.

## Rules the host must not break

**Do not interpret the page.** Return raw values. Never summarise a tree, never
round a number, never decide a turn is finished. Every judgement about page
semantics belongs to CueLine, so that both lanes derive controller evidence from
one implementation.

This is scoped to page semantics. It does not ask a host to set aside its own
safety obligations — notably that `clickRef` can land on the send button and
submit a prompt the operator never read. Take that consent once per run with a
stated scope (which conversation, how many sends), not once per click: a host
that stops mid-loop leaves CueLine holding a submitted-but-unobserved turn, and a
two-hundred-round run cannot ask two hundred times. Outside the agreed scope the
host must stop and answer `ok: false`.

**Never use the natural-language element finder.** It resolves elements by
asking a model, which makes resolution vary between runs. Element handles come
from `readPage` plus deterministic parsing on the CueLine side.

**`tabUrl` must come from `location.href`.** A host's own tab metadata was
observed reporting `https://chatgpt.com` while the page sat on
`https://chatgpt.com/c/<id>`; tab matching rejects the controller tab on that
mismatch.

**Handles are per-read.** `ref_N` values change whenever the page changes —
filling the composer swaps the dictation buttons for a send button and renumbers
the rest. Never reuse a handle from an earlier `readPage`, and never cache a tree.

**Never insert text character by character.** `execCommand("insertText")` with a
large payload hangs the renderer (observed: three consecutive 30s timeouts at
~170k characters). Bulk text arrives as a single synthetic paste inside an
`evaluate` payload, which CueLine composes; the host only forwards it.

**One action per request.** If a request cannot be performed, answer with
`ok: false` and a specific message. Do not substitute a different action, and do
not answer a request you did not read.
