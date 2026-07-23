# Changelog

## Unreleased

## 0.6.2 - 2026-07-23

### Added

- Added a public, no-dispatch Goalbraid decision bridge. It validates Python-compatible canonical request digests, constrains Pro output to Goalbraid's closed runnable set, requires a fully verified CueLine run, and publishes one immutable advisory response without importing or invoking Omnilane.
- Added an executor-owned caller-work lease keeper. It starts the exact fenced claim, renews it on a non-overlapping 60-second client-side timer, exposes an abort signal, separates the one-hour no-progress review deadline from the five-minute claim TTL, and enforces a 24-hour absolute limit without moving liveness into the LLM or MCP server.
- Added stateless `cueline_heartbeat_caller_job` and `cueline_record_caller_job_progress` MCP tools. Progress accepts only completed tool/checkpoint/verification kinds with lowercase SHA-256 evidence identities; any earlier hash on the same claim is deduplicated and cannot extend the deadline.
- A progress stall or absolute limit now attempts a durable `caller_work_review_required` transition before exposing the lease abort. The old job becomes `ambiguous` and cannot be revived; Pro must explicitly dispatch a fresh job in the same run.
- Progress replay now persists the complete accepted evidence-hash history in derived claim state, so `A → B → A` remains rejected by the reducer itself. Lease reconstruction uses the original durable start and latest durable progress anchors, so restarting the executor cannot reset either deadline.
- Quiesced any in-flight durable renewal before a lease abort becomes observable, kept terminal submission inside the active lease scope, and delayed MCP caller binding until the first successful caller operation.

### Fixed

- The public Goalbraid response publisher now reloads the exact request file and enforces the request prompt, run ID, caller executor, and disabled process-execution binding itself. Direct callers can no longer bypass the high-level bridge's advice-only authority checks.
- ChatGPT `Message delivery timed out. Please try again.` turns are now a durable, explicit delivery-failure state instead of permanent controller pending or malformed controller output. Detection is read-only and records the exact run/round/request, conversation, redacted composer state, fixed failure code, assistant-text hash, and evidence hash.
- Delivery-timeout recovery never fills the composer or resends. A separate operator command authorizes one evidence-bound Retry action; CueLine revalidates the same submitted turn, empty composer, zero attachments, disabled Send button, and one scoped Retry target, then consumes the grant while preserving the original round and request identity. After that durable checkpoint, one synchronous page task revalidates the complete DOM guard and pre-inspected target before invoking only that existing assistant Retry control. A response or target change that wins before the page task is permanently recorded as a skipped Retry with no click.

### Verification

- 725/725 tests pass, including four publisher-level negative cases for a mismatched request, mismatched run ID, process executor, and enabled process execution; every case proves that no response file is created.
- 737/737 tests pass with `--test-concurrency=1`; the focused caller-work and MCP suites pass 37/37. Typecheck, documentation, plugin, CLI-contract, and diff checks pass. The built public API reports 60-second heartbeat, one-hour progress-review, and 24-hour absolute-limit defaults; the real installed `cueline mcp serve` surface lists nine tools including heartbeat and progress. A final independent read-only review directly replayed `A → B → A`, checked both restart deadlines, and returned `PASS` with no blocker in the scoped paths.
- 751/751 tests pass for the delivery-timeout recovery, including the actual atomic page evaluator, no-click assistant/target changes, and a second same-identity continuation after a consumed skip. Typecheck, documentation, plugin, CLI-contract, and diff checks pass. A final scoped Omnilane review confirmed the core atomic guard/consume ordering but returned `FAIL` on those two then-missing test proofs; both cited gaps were added and pass locally. That review process ended at its timeout after emitting the verdict, so no post-fix independent `PASS` is claimed.

## 0.6.1 - 2026-07-22

### Fixed

- Known historical ChatGPT conversations now wait for readable message history
  before staging or sending. A degraded `0/0` history times out as definitely
  not sent, with no composer fill and no Send action.
- Pre-click submission checkpoints now permanently record redacted composer
  state plus the actual tab, target kind, coordinate, button geometry,
  viewport, device pixel ratio, `elementFromPoint`, focus, and visibility
  evidence. Each attempt still permits at most one Send action.
- Attachment-backed Send no-ops now use a reusable, durable one-shot recovery
  gate. A new grant requires a newer permanent definitely-not-sent failure and
  fresh read-only Pro evidence from the exact conversation. An empty composer
  may safely restage the same round, request, and prompt hash; the next matching
  request consumes the grant before its single submission action.
- Pasted-text identity now scans the dedicated
  `Open pasted text attachment. Too long to show in text field` button
  independently from attachment counting. Sibling Open and Remove controls
  therefore prove one pasted-text attachment without counting it twice.
- Permanent `controller_turn_submitted` proof is now monotonic across later
  read-only observation failures. For the exact consumed post-fix retry, an
  exact Pro run/round/request envelope takes precedence over stale not-sent
  count evidence, returns the run to read-only observation, and clears the
  obsolete recovery marker when the command is accepted. Unsubmitted exact
  envelopes still fail closed.

### Verification

- 715/715 tests pass. Regression coverage replays source events 2430-2432 and
  2459-2478, proves each authorization is consumed once, permits another grant
  only after a newer permanent no-op, preserves the original request identity
  when restaging an empty composer, and restricts submitted proof to a new user
  turn or answering start. The round 134 tail now also proves an exact existing
  `inspect` response is accepted without any round 135 submission, while the
  same envelope without permanent submitted proof remains frozen.

## 0.6.0 - 2026-07-21

### Added

- Structured pending-observation diagnostics. When a submitted-turn
  observation stays pending with a stable signature for 10 minutes,
  CueLine records why (failed condition, baselines, evidence sources) in
  durable run state, surfaced as `controller.pendingDiagnostic` in JSON
  `run status` and as `controller_pending_diagnostic` in text output.

### Fixed

- Submitted-turn recovery no longer deadlocks in `pending` when ChatGPT
  long-conversation DOM virtualization makes the visible user-message count
  regress below the pre-send baseline. Observation is now identity-first:
  every visible user message is scanned for the request id and every
  assistant message for the exact controller envelope; message counts are
  advisory evidence only. A completed Pro reply present in the ordinary
  message DOM with the exact run/round/request envelope is accepted through
  the new `count_degraded_message_dom_exact_envelope` response source
  (Pro evidence required; recovered dispatch stays deferred).
- Count regression on the same conversation is recorded explicitly,
  re-baselines the observation baseline, and forbids `definitely_not_sent`.
  Outside regression, `definitely_not_sent` additionally requires both the
  full-DOM and the accessibility-snapshot request-id scans to miss before
  the one-shot not-sent retry can be authorized.

### Verification

- 703/703 tests pass; typecheck clean; `release:check` findings empty.

## 0.5.0 - 2026-07-21

### Fixed

- Add read-only misdirected submission recovery for a submitted controller turn that landed in the wrong ChatGPT conversation. `cueline run reconcile ... --misdirected-conversation-url URL` now requires exact orphan envelope evidence, a clean bound conversation at the prior envelope, Pro evidence, and then authorizes only the existing one-shot not-sent retry. Browser submission now also checks the expected conversation URL before any composer mutation or send click.
- Harden misdirected recovery observation against ChatGPT hydration races. Orphan conversation reads now require a stable snapshot and cannot report `confirmed` unless the same evidence snapshot has the exact orphan envelope, both conversations idle, the bound request absent, and the prior bound envelope present.
- Fix misdirected recovery livelock on cold observation tabs. `observeMisdirectedTurn` now polls within one call until orphan and bound conversations reach stable hydrated evidence or the deadline; deadline `pending` JSON includes full evidence for diagnostics.
- Controller decision pending continuations can perform durable local dispatch without a browser; browser resolution remains lazy until the next browser-bound turn.

- Codex IAB fallback now converts session-filtered
  `agent.browsers.get("iab")` failures into `IAB_BACKEND_NOT_REGISTERED`
  with missing-session-metadata versus no-session-match diagnostics and
  recovery guidance.

### Verification

- 696/696 tests pass. The live chain in `/Users/vincentw/.openclaw/changelogs/2026-07-21-cueline-iab-session-provider-recovery.md` verifies session-provider loss, fail-closed recovery, misdirected submission evidence gates, and restored round 95 delivery for `run_2707dc7332cd6d6f9c5c3d5cf21a33fd` events 1715-1723. This chain is release evidence for the 1.0 B-area "host mutation event" bar.

## 0.4.8 - 2026-07-20

### Fixed

- Restarted submitted-turn recovery can now recover a completed Pro response
  from the accessibility snapshot when ChatGPT long-conversation
  virtualization reports zero ordinary message nodes. The exception requires
  the exact bound conversation, selected Pro label, stopped-answering state,
  Pro response model slug, and full protocol/run/round/request envelope inside
  a ChatGPT-authored article; it never falls back to arbitrary page or user
  text.
- The same exact assistant envelope now remains authoritative during the
  second recovery read. A virtualized stale or missing last user message can
  no longer reject it; without an exact envelope, visible prompt matching
  remains mandatory.
- Restarted submitted-turn recovery no longer treats a hydration jump from a
  persisted zero user-message baseline to the page's full historical count as
  proof that the current controller request was sent. CueLine now requires
  exact current-request evidence before parsing the last assistant response;
  when the exact prompt or attachment is still staged and Pro is idle, that
  composer evidence wins and the historical response cannot trigger repair.
- Caller mode now returns `ready` after accepting a count-degraded
  accessibility response containing a `dispatch`. The command remains durable
  but is not registered or executed until a separate explicit `continue`; the
  recovery call also cannot advance into another controller round.

### Verification

- 687/687 tests pass. A simulated restarted round 94 with baseline user count
  111 and an ordinary DOM count of zero recovered the exact accessibility
  response, made zero submit/send calls, stayed on round 94, and registered its
  dispatch only on the next independent continuation. Separate stale and null
  `lastUserText` regressions plus a failed `possibly_sent` lifecycle case verify
  that the second recovery read preserves the exact assistant envelope and its
  deferred-dispatch provenance. The existing real ChatGPT Web Pro round 87
  recovery likewise performed one read-only observation, made zero submit/send
  calls, and created no round 88.

## 0.4.7 - 2026-07-20

### Fixed

- A resolved ChatGPT send click is no longer treated as proof that the
  controller turn was submitted. CueLine now waits for bounded post-click
  acknowledgement: the exact request, a new user or assistant turn, answering
  start, or a newly created conversation proves submission. An unchanged
  staged prompt with stable message counts is `definitely_not_sent`; a prompt
  that leaves the composer without corroborating evidence is `possibly_sent`
  and is never clicked again automatically.
- Fresh read-only `definitely_not_sent` recovery now records the confirmation
  and abandonment, then returns an explicit pause boundary. The same
  `continueCueLineRun()` invocation cannot fall through and resend; only a
  separate continuation may retry the same controller round once.

### Verification

- 673/673 tests pass, including resolved-click no-op, exact user request,
  attachment disappearance with and without answering evidence, zero-submit
  recovery, and one-submit independent continuation regressions. Typecheck,
  package dry-run, and whitespace validation also pass.

## 0.4.6 - 2026-07-20

### Fixed

- Historical response reconciliation now pauses after accepting the recorded
  command instead of falling through into the normal controller loop. In 0.4.5
  the same invocation could mint the next round and call the browser's submit
  path — contradicting the read-only reconciliation contract and spending a
  Pro send without an explicit continue. The reconcile branch now returns an
  explicit awaiting state; only a fresh `continue` may drive the next round.
- A round minted by that fallthrough and blocked before submission (pending
  turn still `requested`, no submission events, `run_failed CUELINE_INTERNAL`)
  can now enter the pre-submission not-sent confirmation path. Recovery still
  requires the operator plus a fresh read-only page observation, and the retry
  stays on the same round.

### Verification

- 669/669 tests pass, including new regressions: the full wedged-run event
  sequence (submission checkpoints, rejected response, staged repair, real
  runtime takeover) reconciles against a browser adapter whose every method
  throws on invocation — the first continue succeeds with zero browser calls
  and no next-round events, and only a second independent continue mints the
  next round exactly once; a fallthrough-polluted round is formally confirmed
  not sent with the round rolled back.

## 0.4.5 - 2026-07-20

### Fixed

- Operator-confirmed not-sent retries that reuse the staged composer attachment
  now keep the attachment's original `request_id` as the controller-visible
  protocol identity instead of minting a fresh retry id. The staged attachment
  is immutable and embeds that id, so the old behavior made Pro's correct reply
  fail identity validation with `CONTROL_ID_MISMATCH` and staged a needless
  repair prompt. The retry lineage stays in `retry_of_request_id`, and a reply
  carrying any other request identity still freezes the run without a repair
  send.
- Runs already wedged by the old dual-identity retry (response received,
  rejected as `CONTROL_ID_MISMATCH`, repair prompt staged but never sent) now
  reconcile read-only on continuation: the permanently recorded response is
  re-validated against the attachment's own identity with no page interaction,
  no repair send, and no new round. Accepting a command also clears the linked
  not-sent recovery state.

### Verification

- 667/667 tests pass, including new regressions: the wedged-run event sequence
  reconciles read-only against a browser adapter that throws on any page
  access, a recorded response from a different conversation fails closed,
  replay restores the attachment's controller identity from permanent events,
  and an operator-confirmed attachment retry that receives a reply for any
  other request identity freezes without repairing.

## 0.4.4 - 2026-07-19

### Fixed

- Accept plain objects created in another Node realm when canonicalizing
  durable state. A controller driving CueLine from a separate vm/context hands
  over objects whose `Object.prototype` has a different identity; the
  non-plain-object guard rejected them as `CANONICAL_JSON_UNSUPPORTED_Object`,
  aborting `RunStore.load` before operator-confirmed not-sent recovery could
  write anything. Plainness is now judged by prototype-chain shape plus the
  `[object Object]` brand, so foreign plain data canonicalizes identically
  while Date/Map/Set/RegExp, typed arrays, and class instances from any realm
  stay rejected.

### Verification

- New unit and regression tests build cross-realm values with `node:vm`:
  foreign plain objects and JSON-parsed specs canonicalize and hash exactly
  like same-realm values, foreign non-plain objects still throw, and job spec
  hashes recompute for specs materialized in a controller realm. The full
  suite passes 653/653.
- A real wedged run (`reconciliation_required`, round 68) loads past the
  previous crash point with zero durable writes and no resend.

## 0.4.3 - 2026-07-19

### Fixed

- Reject injected browser objects before any durable continuation write unless
  `sendTurn` is callable and split `submitTurn` / `observeTurn` methods are
  supplied as a callable pair. The stable `BROWSER_ADAPTER_INVALID` error lists
  only missing method names. A narrow legacy recovery recognizes only the exact
  pre-submission `browser.sendTurn is not a function` event shape, requires a
  fresh idle Pro observation of the exact conversation with the request absent,
  and then abandons the old request for one round-preserving retry.
- Capture child stdin/stdout/stderr stream errors in the process runner. An
  early-exiting worker can emit `EPIPE` while CueLine is still writing a large
  stdin task; the stream error is now bounded into job evidence while the real
  child exit status remains authoritative, instead of crashing the controller
  loop and concurrent jobs.

### Verification

- Release candidate preflight passes all 649 tests plus metadata agreement,
  typecheck, plugin validation, shell install tests, package contents, and diff
  hygiene.
- Runtime regression proves an invalid built-in IAB module object returns
  `BROWSER_ADAPTER_INVALID` with round, pending turns, and event sequence
  unchanged; the legacy recovery fixture abandons and retries exactly once.
- A 5 MB stdin regression against an immediately exiting child completes
  without an uncaught `EPIPE`.

## 0.4.2 - 2026-07-18

### Fixed

- Reuse CueLine's own leftover attachment when retrying an operator-confirmed
  not-sent turn. A long controller prompt is auto-converted by ChatGPT into a
  composer attachment; when the submit click was ambiguous and the operator
  confirmed the prompt was not sent, that attachment stays in the composer. The
  pre-existing-attachment guard previously refused it as foreign
  (`CONTROLLER_PROMPT_NOT_READY`), deadlocking the run at `prompt_not_sent` /
  `safeNextAction=retry`. The retry now reuses the single leftover attachment
  only when it is provably CueLine's own — `notSentRecovery` is set,
  `attachmentPromptExpected` is true, exactly one attachment is present, and
  undoing the retry request-id swap reproduces the operator-confirmed
  `promptHash` — skipping the re-fill instead of refusing. Any other
  pre-existing attachment is still refused, so a user's own attachment is never
  mixed in or cleared.

### Verification

- Red/green regression: a new unit test reuses the leftover attachment without
  re-filling and clicks send exactly once; it failed against the old guard and
  passes after the fix.
- Full suite green: unit 250/250, integration 304/304, smoke 6/6, `tsc
  --noEmit` clean.

## 0.4.1 - 2026-07-18

### Fixed

- Recover an already completed ChatGPT Pro attachment response after CueLine or
  the machine restarts, even when fresh page hydration mounts fewer historical
  assistant message nodes than the durable pre-submit baseline. An exact
  `cueline/0.1` run/round/request envelope can now establish response freshness
  without weakening the exact conversation URL, Pro composer label, Pro
  response slug, user-message baseline, hydration, or idle-controller checks.
- Keep recovery read-only and idempotent: the submitted request is accepted
  without resending it, registering a duplicate job, or requiring manual
  reconciliation. Mismatched request or round identities, a non-Pro response,
  an answering controller, and an attachment without a matching assistant
  envelope remain rejected or pending.

### Verification

- Red/green regression reproduced the rebooted DOM shape (`user 51 -> 52`,
  assistant baseline `4`, hydrated DOM `3`) and the exact round 35 response.
- Full suite: 559/559 tests passed; typecheck, Node support, CLI contracts,
  plugin validation, documentation validation, package dry-run, and `doctor`
  passed.
- Live recovery accepted the existing round 35 `inspect` command for
  `job_1ba71846e6340dd393b5f09693f3b888` with the ChatGPT user-message count
  unchanged at 52 and no duplicate job. The next round stopped safely at
  pre-submit with `CONTROLLER_PROMPT_NOT_READY` and `definitely_not_sent`.

## 0.4.0 - 2026-07-18

### Added

- `cueline mcp serve`: a Model Context Protocol (MCP) stdio server exposing
  CueLine's durable-run surface as seven tools — `cueline_start_run`,
  `cueline_continue_run`, `cueline_run_status`, `cueline_run_doctor`,
  `cueline_claim_caller_job`, `cueline_start_caller_job`, and
  `cueline_list_runs` — so MCP clients (Claude Code, Codex, Gemini CLI, and
  any other MCP host) can drive runs without shelling out to the CLI. The
  JSON-RPC 2.0 transport is hand-rolled; CueLine keeps zero runtime npm
  dependencies. Tool results return the same bounded evidence as the
  programmatic API, never raw transcripts. Process execution still requires
  explicit `allowProcessExecution: true` in the same call — the MCP layer
  never defaults it on — and caller work keeps the existing stable
  `callerId`, claim-ID, and fencing-token contract.

### Verification

- MCP integration tests covering the initialize handshake, tools listing,
  per-tool happy paths, malformed JSON-RPC rejection, the
  `allowProcessExecution` refusal case, and graceful shutdown; a live stdio
  smoke of `cueline mcp serve`; TypeScript typecheck; and 552/552 tests.

## 0.3.2 - 2026-07-18

### Fixed

- Recover wedged `submitted` controller turns after a restart. When durable
  state records a submission as `submitted` but a fresh hydrated observation
  of the exact conversation shows the user-message count unchanged from the
  pre-send baseline, the round's user message absent, and the controller not
  answering, CueLine now reclassifies the submission as definitely not sent,
  abandons the old request, and creates exactly one retry recording
  `retryOfRequestId` — never a duplicate send, never two pending turns.
- Never classify from an unhydrated conversation read: reopening a
  conversation briefly reports zero messages before hydration completes, and
  recovery now waits past that window and keeps refusing while observation
  is ambiguous (count increased, count unknown, controller answering).
- Scope stale reconciliation data to its own round in `run status` output so
  an old round's not-sent recovery can no longer masquerade as the current
  round's reconciliation.
- Surface the wedge in `run doctor` as the stable finding
  `SUBMITTED_TURN_RECOVERY_REQUIRED` with `safeNextAction`
  `recover_submitted_turn` instead of an indefinite observe loop.

### Verification

- Red/green regression fixture reproducing the live wedged run (submitted
  state, unchanged baseline of 50 user messages, absent round message, idle
  controller), five fail-closed negative cases, a reentry case proving no
  second pending turn, TypeScript typecheck, and 543/543 tests.

## 0.3.1 - 2026-07-18

### Fixed

- Accept cancelled `ambiguous` job-result evidence produced when a running
  `work` job is interrupted, keeping persisted run and job listings readable
  without weakening cancellation checks for other terminal statuses.
- Backfill `cancelled: false` when reading pre-0.1.7 job-result evidence that
  predates the field, so legacy runs stay readable; writes still require the
  full strict shape.

### Verification

- Verified with a red/green regression oracle (new tests fail on the 0.3.0
  validator), TypeScript typecheck, build, 535/535 tests, all release gates,
  and live recovery of three previously unreadable on-disk runs, cross-checked
  by an independent adversarial review line.

## 0.3.0 - 2026-07-17

### Added

- Operator tooling: `runs prune` retention sweep over terminal runs (dry-run
  by default, deletion serialized with the runtime lease lock), `run
  audit-secrets` masked scan of durable events for secret-shaped strings, and
  `run export` one-file sanitized support bundles.
- Release engineering: `self-test` offline controller-loop check, `upgrade
  preflight` read-only migration report, `npm run release:check` release
  gate, reproducible pack artifacts with SHA-256 verification, a
  documentation version guard, and a Node 22/24/26 support contract in CI.
- Machine-output contracts: versioned strict JSON Schemas for `doctor`,
  `routing`, `routing explain`, `runs prune`, `run audit-secrets`, and
  `run export`; contract tests reject added fields, nested injection, empty
  sections, and contradictory shapes.

### Fixed

- Run-scoped commands fail closed for an absent run instead of fabricating a
  healthy view; a sweep pins this for every read and mutating surface.
- Secret audit reports a secret-shaped object key as a finding and masks it
  in the finding path instead of echoing it verbatim.
- Prune re-reads runtime ownership inside the lease mutation lock before
  deletion, and only a definite ENOENT counts as a completed removal; any
  other filesystem error keeps the run and records the error.

### Verification

- Verified TypeScript typecheck, build, 532/532 unit/integration/smoke tests,
  plugin validation, pack dry-run, release:check, offline self-test, and
  upgrade preflight on the unified candidate, cross-reviewed adversarially by
  two independent lines (AJV negative oracle: seven malicious mutations all
  rejected).

## 0.2.2 - 2026-07-17

### Fixed

- Apply each run's persisted `maxJobEvidenceChars` to terminal evidence written
  by process execution, caller result submission, and runtime reconciliation,
  keeping event-log and served evidence on the same durable cap.
- Preserve a validated canonical evidence-cap marker when replay falls back to
  run events, so the served bytes and `content_hash` remain stable without
  nesting markers. Legacy `...[truncated N chars]` events remain replayable and
  may be deterministically re-capped.
- Base controller capacity warnings on servable capped-representation lengths.
  Report true source totals beyond durable per-job caps in a separate notice,
  since those discarded characters cannot be retrieved by evidence cursors.

### Verification

- Verified TypeScript typecheck, build, 490/490 unit/integration/smoke tests,
  and diff whitespace checks.
- Verified the built public API with a real process runner: a 7,000-character
  result wrote one 4,000-cap event marker with the true total and completed in
  two controller turns.

## 0.2.1 - 2026-07-17

### Fixed

- Treat a manually confirmed retry request as authoritative for its newly
  observed user message. The abandoned-message late-arrival guard still freezes
  unconfirmed retries, but no longer misclassifies the operator-confirmed retry
  itself as the abandoned request appearing late.
- Accept an already-completed manually confirmed Pro response when its exact
  protocol, run, round, and request envelope matches even if the recorded
  assistant-message baseline already includes that fast response. Non-exact
  responses remain behind the assistant-count freshness gate.
- Add a durable, configurable per-job controller-evidence cap. Full runner
  status remains local, while controller observations receive a deterministic
  capped representation with an explicit marker and the true source length;
  hashes and inspect offsets remain fenced to that representation.
- Warn when total unserved evidence exceeds the remaining-round delivery
  capacity, and tell the controller it may decide from sufficient evidence or
  request focused summarization instead of paging every omitted tail.

### Verification

- Verified 488/488 tests, TypeScript typecheck, plugin validation, and diff
  whitespace checks.
- Verified the public API with the real process runner: two 75,762-character
  advise outputs were each projected through a 4,000-character cap, retained
  their true totals, emitted the remaining-capacity warning, completed, and
  produced a verified run.
- Verified the real built-in Browser recovery path on the original CueLine run:
  round 3 request `msg_f40d51990236834c1add1c5b6e7c5580` and round 4 request
  `msg_d859cbe692ae7c70b5b9dc402ca6de49` were each accepted exactly once,
  with no duplicate resend, job, or event.

## 0.2.0 - 2026-07-16

### Added

- Add `cueline run status-at <run-id> --sequence <n>` to reconstruct a
  sanitized, event-derived historical run state without mutating durable data.
- Add `cueline run diff <left-run-id> <right-run-id>` to compare safe run
  projections without exposing prompts, tasks, outputs, or conversation data.
- Add `cueline run graph <run-id>` to render a bounded Mermaid control-flow
  graph from sanitized timeline entries and exact safe correlations.
- Add `cueline routing explain [lane]` to report pre-spawn runner selection,
  availability, fallback, and rejection reasons without exposing runner argv.

### Fixed

- Add append-only recovery for an operator-confirmed unsent ambiguous controller request. `cueline run reconcile ... --not-sent-confirmed` validates the exact run, conversation, round, request, prompt hash, and Pro evidence; abandons the old identity; permits one same-prompt retry under a new deterministic request ID; and remains idempotent across command repetition or restart.
- Strengthen browser submission checkpoints with run/round/request/prompt identity, a user-message baseline, composer and click-attempt state, a bounded click error, and post-click DOM evidence. Late discovery of the abandoned message or response, prompt drift, extra pending turns, or identity/model/conversation mismatch now freezes the run for manual review instead of risking duplicate controller dispatch.

### Verification

- Verified 479/479 tests, TypeScript typecheck, plugin validation, build, and package-content checks.
- Verified the real built CLI for `run status-at`, `run diff`, `run graph`, and `routing explain`; confirmed `run reconcile` usage still exposes both `--manual-send-confirmed` and `--not-sent-confirmed`.

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
