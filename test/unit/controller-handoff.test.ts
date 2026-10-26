import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  authorizeControllerDeliveryTimeoutRetry,
  authorizeControllerResponseRetry,
  confirmControllerTurnMisdirected,
  confirmControllerTurnNotSent,
  confirmManualControllerSubmission,
  reauthorizeControllerPostFixRetry,
  recordControllerDeliveryTimeoutAttestation,
  submitCueLineCallerJobResult,
} from "../../src/api-controller-handoff.js";
import type { BrowserAdapter } from "../../src/browser/browser-adapter.js";
import { CueLineError } from "../../src/core/errors.js";
import { jobId } from "../../src/core/ids.js";
import {
  initialRunState,
  reduceRunState,
  type CueLineExecutor,
  type CueLineRunState,
  type StoredJob,
} from "../../src/core/state-machine.js";
import { JobStatusStore } from "../../src/jobs/status.js";
import type { ControllerJobSpec } from "../../src/protocol/types.js";
import { readEvents } from "../../src/state/event-log.js";
import { runPaths } from "../../src/state/paths.js";
import { readRuntimeLease } from "../../src/state/runtime-lease.js";
import { RunStore } from "../../src/state/store.js";

const URL_A = "https://chatgpt.com/c/handoff-unit-a";
const URL_B = "https://chatgpt.com/c/handoff-unit-b";
const HASH = "a".repeat(64);

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof CueLineError && error.code === code;
}

async function seed(
  runId: string,
  executor: CueLineExecutor = "caller",
): Promise<{ home: string; store: RunStore<CueLineRunState> }> {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-unit-handoff-"));
  const store = await RunStore.create({
    home,
    runId,
    initialState: initialRunState(runId, "", executor),
    reducer: reduceRunState,
  });
  await store.append("run_created", { request: "handoff unit test", executor });
  return { home, store };
}

async function requestTurn(store: RunStore<CueLineRunState>, round: number, requestId: string): Promise<void> {
  await store.append("controller_turn_requested", {
    round,
    request_id: requestId,
    prompt: `prompt ${requestId}`,
    prompt_hash: `hash-${requestId}`,
    repair_attempt: 0,
  });
}

// Every entry point claims the runtime lease and must give it up on any outcome.
async function assertNoRuntimeOwner(home: string, runId: string): Promise<void> {
  const { ownership } = await readRuntimeLease(home, runId);
  assert.ok(ownership === "missing" || ownership === "released", ownership);
}

async function eventTypes(home: string, runId: string): Promise<string[]> {
  return (await readEvents(runPaths(home, runId).events)).map((event) => event.type);
}

test("manual submission confirmation rejects requests that are neither pending nor abandoned", async () => {
  const runId = "run_handoff_manual_unknown";
  const { home, store } = await seed(runId);
  await requestTurn(store, 1, "msg_known");
  await assert.rejects(
    confirmManualControllerSubmission(runId, { home, requestId: "msg_unknown", conversationUrl: URL_A }),
    hasCode("CONTROLLER_RECONCILIATION_REQUEST_NOT_FOUND"),
  );
  await assertNoRuntimeOwner(home, runId);
});

test("manual submission confirmation requires an exact ChatGPT conversation URL", async () => {
  const runId = "run_handoff_manual_url";
  const { home, store } = await seed(runId);
  await requestTurn(store, 1, "msg_url");
  for (const conversationUrl of [undefined, "https://example.com/c/abc", "https://chatgpt.com/"]) {
    await assert.rejects(
      confirmManualControllerSubmission(runId, {
        home,
        requestId: "msg_url",
        ...(conversationUrl === undefined ? {} : { conversationUrl }),
      }),
      hasCode("CONTROLLER_RECONCILIATION_URL_REQUIRED"),
      String(conversationUrl),
    );
  }
});

test("manual submission confirmation binds an unbound run once and is idempotent", async () => {
  const runId = "run_handoff_manual_bind";
  const { home, store } = await seed(runId);
  await requestTurn(store, 1, "msg_bind");

  const first = await confirmManualControllerSubmission(runId, {
    home,
    requestId: "msg_bind",
    conversationUrl: URL_A,
  });
  assert.deepEqual(first, { runId, requestId: "msg_bind", conversationUrl: URL_A, outcome: "confirmed" });

  const second = await confirmManualControllerSubmission(runId, { home, requestId: "msg_bind" });
  assert.deepEqual(second, {
    runId,
    requestId: "msg_bind",
    conversationUrl: URL_A,
    outcome: "already_confirmed",
  });
  const types = await eventTypes(home, runId);
  assert.equal(types.filter((type) => type === "controller_conversation_bound").length, 1);
  assert.equal(types.filter((type) => type === "controller_turn_manual_submission_confirmed").length, 1);
});

test("manual submission confirmation refuses a URL for a different bound conversation", async () => {
  const runId = "run_handoff_manual_mismatch";
  const { home, store } = await seed(runId);
  await requestTurn(store, 1, "msg_mismatch");
  await store.append("controller_conversation_bound", { request_id: "msg_mismatch", conversation_url: URL_A });

  await assert.rejects(
    confirmManualControllerSubmission(runId, { home, requestId: "msg_mismatch", conversationUrl: URL_B }),
    hasCode("CONTROLLER_RECONCILIATION_CONVERSATION_MISMATCH"),
  );
  // Omitting the URL falls back to the bound conversation.
  const confirmed = await confirmManualControllerSubmission(runId, { home, requestId: "msg_mismatch" });
  assert.equal(confirmed.conversationUrl, URL_A);
  assert.equal(confirmed.outcome, "confirmed");
});

test("manual submission confirmation is refused once a same-or-newer round command was accepted", async () => {
  for (const [label, command] of [
    ["same request", { request_id: "msg_superseded", round: 0 }],
    ["newer round", { request_id: "msg_other", round: 3 }],
  ] as const) {
    const runId = `run_handoff_manual_superseded_${label.replace(" ", "_")}`;
    const { home, store } = await seed(runId);
    await requestTurn(store, 2, "msg_superseded");
    await store.append("controller_command_accepted", { command });

    await assert.rejects(
      confirmManualControllerSubmission(runId, { home, requestId: "msg_superseded", conversationUrl: URL_A }),
      hasCode("CONTROLLER_RECONCILIATION_SUPERSEDED"),
      label,
    );
  }
});

test("not-sent and misdirected confirmations require exactly one known pending turn", async () => {
  const runId = "run_handoff_not_sent";
  const { home, store } = await seed(runId);
  await requestTurn(store, 1, "msg_one");

  await assert.rejects(
    confirmControllerTurnNotSent(runId, { home, requestId: "msg_missing" }),
    hasCode("CONTROLLER_RECONCILIATION_REQUEST_NOT_FOUND"),
  );
  await assert.rejects(
    confirmControllerTurnMisdirected(runId, {
      home,
      requestId: "msg_missing",
      misdirectedConversationUrl: URL_B,
    }),
    hasCode("CONTROLLER_RECONCILIATION_REQUEST_NOT_FOUND"),
  );

  await requestTurn(store, 2, "msg_two");
  await assert.rejects(
    confirmControllerTurnNotSent(runId, { home, requestId: "msg_one" }),
    hasCode("OTHER_CONTROLLER_TURNS_PENDING"),
  );
  await assert.rejects(
    confirmControllerTurnMisdirected(runId, {
      home,
      requestId: "msg_one",
      misdirectedConversationUrl: URL_B,
    }),
    hasCode("OTHER_CONTROLLER_TURNS_PENDING"),
  );
  await assertNoRuntimeOwner(home, runId);
});

test("post-fix retry reauthorization requires browser submitted-turn evidence before reading state", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-unit-handoff-"));
  for (const browser of [undefined, {} as BrowserAdapter]) {
    await assert.rejects(
      reauthorizeControllerPostFixRetry("run_handoff_absent", {
        home,
        requestId: "msg",
        round: 1,
        conversationUrl: URL_A,
        ...(browser === undefined ? {} : { browser }),
      }),
      hasCode("CONTROLLER_NOT_SENT_EVIDENCE_REQUIRED"),
    );
  }
});

test("retry authorizations reject malformed evidence hashes before reading state", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-unit-handoff-"));
  for (const evidenceHash of ["", "A".repeat(64), "a".repeat(63), `${"a".repeat(64)}\n`]) {
    const request = { home, requestId: "msg", round: 1, conversationUrl: URL_A, evidenceHash };
    await assert.rejects(
      authorizeControllerDeliveryTimeoutRetry("run_handoff_absent", request),
      hasCode("CONTROLLER_DELIVERY_TIMEOUT_RETRY_STATE_INVALID"),
    );
    await assert.rejects(
      authorizeControllerResponseRetry("run_handoff_absent", request),
      hasCode("CONTROLLER_RESPONSE_RETRY_STATE_INVALID"),
    );
  }
});

test("delivery-timeout attestation and retries reject a run with no matching recovery state", async () => {
  const runId = "run_handoff_no_recovery";
  const { home, store } = await seed(runId);
  await requestTurn(store, 1, "msg_turn");
  await store.append("controller_conversation_bound", { request_id: "msg_turn", conversation_url: URL_A });
  const request = { home, requestId: "msg_turn", round: 1, conversationUrl: URL_A };

  await assert.rejects(
    recordControllerDeliveryTimeoutAttestation(runId, {
      ...request,
      userTurnPresent: true,
      retryActionVisible: true,
      isAnswering: false,
      composerInlineTextLength: 0,
      composerAttachmentCount: 0,
      composerSendButtonEnabled: false,
    } as Parameters<typeof recordControllerDeliveryTimeoutAttestation>[1]),
    hasCode("CONTROLLER_DELIVERY_TIMEOUT_ATTESTATION_STATE_INVALID"),
  );
  await assert.rejects(
    authorizeControllerDeliveryTimeoutRetry(runId, { ...request, evidenceHash: HASH }),
    hasCode("CONTROLLER_DELIVERY_TIMEOUT_RETRY_STATE_INVALID"),
  );
  await assert.rejects(
    authorizeControllerResponseRetry(runId, { ...request, evidenceHash: HASH }),
    hasCode("CONTROLLER_RESPONSE_RETRY_STATE_INVALID"),
  );
  await assertNoRuntimeOwner(home, runId);
});

async function registerJob(
  store: RunStore<CueLineRunState>,
  spec: ControllerJobSpec,
): Promise<StoredJob> {
  const job: StoredJob = {
    jobId: jobId(store.runId, spec.job_key, spec),
    jobKey: spec.job_key,
    required: true,
    spec,
    status: "pending",
    output: null,
    error: null,
    ...(spec.mode === "work" ? { callerWork: { claim: null, nextFencingToken: 0 } } : {}),
  };
  await store.append("job_registered", { job });
  return job;
}

const adviceSpec: ControllerJobSpec = { job_key: "advice", lane: "default", mode: "advise", task: "advise me" };

test("caller job results require a caller run and a known job", async () => {
  const processRun = "run_handoff_result_process";
  const { home: processHome, store: processStore } = await seed(processRun, "process");
  const processJob = await registerJob(processStore, adviceSpec);
  await assert.rejects(
    submitCueLineCallerJobResult(processRun, processJob.jobId, { status: "succeeded", output: "x" }, { home: processHome }),
    hasCode("CALLER_EXECUTOR_REQUIRED"),
  );

  const callerRun = "run_handoff_result_unknown";
  const { home } = await seed(callerRun);
  await assert.rejects(
    submitCueLineCallerJobResult(callerRun, "job_unknown", { status: "succeeded" }, { home }),
    hasCode("JOB_NOT_FOUND"),
  );
});

test("an advice result is recorded once and later submissions report already_terminal", async () => {
  const runId = "run_handoff_result_advice";
  const { home, store } = await seed(runId);
  const job = await registerJob(store, adviceSpec);
  const now = () => new Date("2026-10-26T00:00:05.000Z");

  const submitted = await submitCueLineCallerJobResult(
    runId,
    job.jobId,
    { status: "succeeded", output: "advice text" },
    { home, now },
  );
  assert.deepEqual(submitted, { runId, jobId: job.jobId, outcome: "submitted" });
  const persisted = await new JobStatusStore(home).read(job.jobId);
  assert.equal(persisted?.status, "succeeded");
  assert.equal(persisted?.runId, runId);
  assert.equal(persisted?.jobKey, "advice");
  assert.equal(persisted?.result?.output, "advice text");

  const again = await submitCueLineCallerJobResult(runId, job.jobId, { status: "failed", error: "late" }, { home, now });
  assert.deepEqual(again, { runId, jobId: job.jobId, outcome: "already_terminal" });
  assert.equal((await new JobStatusStore(home).read(job.jobId))?.status, "succeeded");
  await assertNoRuntimeOwner(home, runId);
});

test("advice results refuse a work claim and work results require one", async () => {
  const runId = "run_handoff_result_claims";
  const { home, store } = await seed(runId);
  const advice = await registerJob(store, adviceSpec);
  const work = await registerJob(store, {
    job_key: "work",
    lane: "default",
    mode: "work",
    task: "edit",
    workdir: tmpdir(),
  });
  const claim = { claimId: "claim_x", callerId: "caller", fencingToken: 1 };

  await assert.rejects(
    submitCueLineCallerJobResult(runId, advice.jobId, { status: "succeeded" }, { home, claim }),
    hasCode("CALLER_WORK_CLAIM_UNEXPECTED"),
  );
  await assert.rejects(
    submitCueLineCallerJobResult(runId, work.jobId, { status: "succeeded" }, { home }),
    hasCode("CALLER_WORK_CLAIM_REQUIRED"),
  );
});

test("persisted terminal evidence for another run or job key conflicts with a caller result", async () => {
  const runId = "run_handoff_result_conflict";
  const { home, store } = await seed(runId);
  const job = await registerJob(store, adviceSpec);
  await new JobStatusStore(home).write({
    jobId: job.jobId,
    runId: "run_someone_else",
    jobKey: "advice",
    execution: "foreground",
    status: "failed",
    startedAt: "2026-10-26T00:00:00.000Z",
    finishedAt: "2026-10-26T00:00:01.000Z",
    error: "foreign",
  });

  await assert.rejects(
    submitCueLineCallerJobResult(runId, job.jobId, { status: "succeeded", output: "x" }, { home }),
    hasCode("CALLER_JOB_RESULT_CONFLICT"),
  );
});
