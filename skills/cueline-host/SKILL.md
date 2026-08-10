---
name: cueline-host
description: Act as CueLine's browser hands — watch a bridge directory and perform one browser action per request against a ChatGPT tab. Use when the user says 當 CueLine 的手 / cueline host / 跑 CueLine 主控 / start the CueLine bridge, or points at a host-bridge directory. Not for deciding what CueLine should do next.
---

# CueLine host

A ChatGPT Pro conversation is the head. You are both hands: you drive the page,
and you perform the local work Pro asks for. What you never do is decide what
the next step should be.

Ask for the bridge directory if the user has not named one. Everything below is
relative to it.

## Starting a run

The controller loop runs as a detached process, never as a command you wait on.
It blocks on browser requests only you can answer, so waiting on it makes you
wait on yourself — the observed failure is a 120-second `HOST_BRIDGE_TIMEOUT`
with nothing sent.

Use Claude Code Desktop's shell-tool **Run in background** mode. Do not append
shell `&`, `disown`, or `nohup`: the desktop harness owns the background task.
Never restart merely because the launch tool call returned; a shell-detached
child can still be alive, and a restart would put two daemons on one bridge.

```
cueline-claude-desktop-lane daemon "<request>"
```

Then enter the request loop below. `cueline-claude-desktop-lane status`
prints the latest run summary, and `lane.log` in the bridge directory holds the
full progression.

## Caller work

Read durable run status first. The two waiting states have different contracts:

- `awaiting_caller` is advise. Do not claim it and do not start a lease. Perform the
  requested inspection, then call `cueline_submit_caller_job_result` without
  `claimId`, `callerId`, or `fencingToken`.
- `awaiting_caller_work` is work. Keep one MCP session open:
  1. Call `cueline_claim_caller_job` with a stable `callerId`.
  2. Call `cueline_start_caller_work_lease` with the returned claim proof. The
     resident MCP server owns heartbeat, progress timeout, maximum lifetime, and
     abort state.
  3. Work only inside returned `resolvedWorkdir`.
  4. Record real durable checkpoints with `cueline_record_caller_job_progress`;
     inspect executor health with `cueline_caller_work_lease_status`.
  5. Submit the terminal result with the complete claim proof. Successful work
     submission ends the lease automatically.

If work stops before submission, call `cueline_end_caller_work_lease`. Occasional
manual heartbeat is not a substitute for the resident lease.

<!-- Legacy pre-lease caller workflow retained only as historical context.

Pro delegates work through CueLine jobs, and you perform them with your own
tools. Use the `cueline` MCP tools, in this order, for each job:

1. `cueline_claim_caller_job` — keep the returned `claimId` and `fencingToken`;
   every later call needs both, and a stable `callerId` of your own choosing.
2. `cueline_start_caller_job`
3. do the work
4. `cueline_record_caller_job_progress` at real checkpoints (heartbeats are not
   progress)
5. `cueline_submit_caller_job_result` with the terminal `status`

Step 5 is not optional. A claimed job that never reaches a terminal status
leaves the run blocked forever.

-->

## The browser request loop

Use the mailbox helper for every request. It replaces all manual file moves and
phase edits, so a browser request is only three tool calls: claim, one browser
action, publish.

```bash
cueline-claude-desktop-mailbox claim "$CUELINE_HOST_BRIDGE"
```

The command waits and prints exactly one request JSON line after atomically
moving it to `inflight/` and persisting `action_started`. Perform exactly that
one browser action, then publish its response through stdin:

```bash
printf '%s' '<response-json>' | \
  cueline-claude-desktop-mailbox respond \
  "$CUELINE_HOST_BRIDGE" '<request-id>'
```

The publish command persists `action_completed`, writes the partial response,
persists `response_published`, and performs the final atomic rename. Do not
narrate, rescan, or manually edit mailbox files between these commands. This
bounded path is required because CueLine's composer stability probe has a
120-second composer-ready window. Browser host operations retain a 180-second
ceiling. The previous real Claude Desktop run needed
about 41 seconds for that probe, so the helper reduces overhead but does not by
itself satisfy the previous 30-second window; the lane override removes that blocker.

Manual phase handling below is recovery documentation only.

Repeat until stopped:

1. Take the oldest request and atomically rename
   `requests/<id>.json` to `inflight/<id>.json`. If rename fails, another consumer
   won the claim; restart the scan. Never claim with read-then-delete.
2. Atomically rewrite the inflight record with the original request, ISO-8601
   `updatedAt`, and phase `claimed`.
3. Persist phase `action_started` immediately before the browser tool call.
4. Execute exactly one requested action; persist phase `action_completed`.
5. Write `responses/<id>.json.partial`, persist phase `response_published`, then
   atomically rename the response into place.

Never delete inflight records. CueLine removes request, inflight, and response only
after consuming the response. A crash therefore preserves whether a side-effecting
action may already have happened.

<!-- Legacy read-delete bridge workflow retained only as historical context.

Repeat until the user stops you or `stop.flag` appears in the bridge directory:

1. List `requests/`. Take the oldest `*.json`. If empty, wait ~1s and list again.
2. Read it, then **delete it** — before doing anything else.
3. Perform the single action its `method` names. Nothing else.
4. Write `responses/<id>.json.partial`, then rename it to `responses/<id>.json`.

Deleting in step 2 is what stops an action running twice. Acting first and
deleting after means your next poll re-reads the same request — for a send-button
click that submits the prompt twice.

Writing through `.partial` in step 4 stops CueLine reading a half-written file.

-->

## Response shape

```json
{ "id": "<the id from the request>", "ok": true,  "result": <raw value> }
{ "id": "<the id from the request>", "ok": false, "error": { "code": "HOST_TAB_CLOSED", "message": "..." } }
```

`id` must match the request. Never answer a request you did not read.

## Methods

| `method` | `params` | What to do | `result` |
|---|---|---|---|
| `listTabs` | — | list tabs | `[{tabId, url, title}]` |
| `activeTab` | — | the focused tab | `{tabId, url, title}` or `null` |
| `newTab` | `{url}` | `preview_start` with that concrete URL; the shim supplies `https://chatgpt.com/` when opening the controller surface | `{tabId, url}` |

**A closed browser surface is not a failure.** If your tab tools report that no
preview or browser pane is open, answer `listTabs` with `[]` and `activeTab`
with `null`: that is the true tab count, and CueLine responds to it by sending
`newTab`. Answering `ok: false` there kills the run before it reaches that path
— observed twice, as `NO_PREVIEW_OPEN`, whose own message names the remedy:
`Use preview_start with {"url": "https://…"} to open a browser tab at URL`.
Reserve `ok: false` for genuine faults: a crashed tool, a denied permission, a
tab that vanished mid-action.
| `navigate` | `{tabId, url}` | navigate | `null` |
| `tabUrl` | `{tabId}` | `javascript_exec` returning `location.href` | the URL string |
| `tabTitle` | `{tabId}` | `javascript_exec` returning `document.title` | the title string |
| `evaluate` | `{tabId, source}` | `javascript_exec` with `source` **unmodified** | its return value, verbatim |
| `readPage` | `{tabId, interactiveOnly}` | `read_page`; filter `interactive` when true, otherwise unfiltered | the tree text, verbatim |
| `clickRef` | `{tabId, ref}` | `computer` `left_click` with that `ref` | `null` |

### Tagged evaluate results

For `evaluate`, preserve the host tool's result type explicitly; never infer it from
the first character:

```json
{ "protocol": "cueline.evaluate-result/1", "encoding": "literal", "value": "{\"a\":1}" }
{ "protocol": "cueline.evaluate-result/1", "encoding": "json", "value": "{\"a\":1}" }
```

Use `literal` when the page result itself is a string. Use `json` only when the host
tool transport serialized a non-string result as JSON text. Non-string typed results
may be returned directly.

## Rules

**Return raw values.** Never summarise, truncate, reformat, or round anything.
`readPage` results go in whole. If a result is too large to be comfortable, it
still goes in whole — CueLine parses it, you do not.

**Never interpret page state, and never substitute a different action.** Not
whether a reply finished, not whether a page looks right, not whether some other
element would work better. If a request cannot be performed, answer `ok: false`
with a specific message and move on. This rule is about page semantics; it does
not suspend your own safety obligations, which are covered next.

## Sending on the operator's behalf

A `clickRef` can land on the send button, which submits a prompt the operator has
not read. That is a real action with real cost, so it needs real consent — but
asking per click makes a two-hundred-round run unusable, and a run that stalls
mid-loop leaves CueLine holding a submitted-but-unobserved turn.

So take consent once, up front, and scope it by destination rather than by count.
A run is unbounded by design — the controller decides when it is done, and a cap
on sends would end the run somewhere the controller never chose.

After the first send, read `location.href` and hold that conversation URL for the
rest of the run. Every later send must land on the same URL. Within it, click
send without asking again.

Outside it — a different conversation, or anything that looks like it would post
somewhere other than that ChatGPT conversation — stop, answer `ok: false` with a
specific message, and ask.

If the operator has not agreed to unattended sending yet, ask before starting the
loop rather than discovering it on the first send. When they stop you, stop at a
round boundary: never between clicking send and reading the reply, which leaves
CueLine holding a submitted-but-unobserved turn.

**Never use the natural-language element finder.** It resolves elements by asking
a model, so the same page can give different answers. Handles reach you inside
`clickRef`; CueLine derived them from a `readPage` you already returned.

**`tabUrl` comes from `location.href`.** Tab metadata has been seen reporting
`https://chatgpt.com` while the page sat on `https://chatgpt.com/c/<id>`, and
CueLine rejects the controller tab on that mismatch.

**Never edit `source`.** Run it exactly as given, including large paste payloads.
Do not "improve" it, do not split it, and never retype text character by
character — `execCommand("insertText")` with a large payload hangs the renderer.

**Handles expire.** Never reuse a `ref` you saw in an earlier `readPage`, and
never cache a tree. Filling the composer renumbers everything.

## Reporting

Every ~20 requests, and whenever you answer `ok: false`, tell the user in one
line: how many requests you have served and the last method. Do not paste
request or response bodies into the chat.
