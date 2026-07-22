import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  BrowserAdapter,
  BrowserMisdirectedTurnObservation,
  BrowserMisdirectedTurnObservationInput,
  BrowserSubmittedTurnEvidence,
  BrowserSubmittedTurnObservation,
  BrowserTurnHooks,
  BrowserTurnInput,
  ControllerTurn,
} from "../../src/browser/browser-adapter.js";
import {
  cancelCueLineJob,
  cancelCueLineRun,
  confirmControllerTurnMisdirected,
  confirmControllerTurnNotSent,
  continueCueLineRun,
  loadCueLineRunState,
  loadCueLineRunStatus,
  reauthorizeControllerPostFixRetry,
  reconcileCueLineRuntime,
  startCueLineRun,
  submitCueLineCallerJobResult,
  takeoverCueLineRuntime,
} from "../../src/api.js";
import { commandHash, jobId } from "../../src/core/ids.js";
import { CueLineError } from "../../src/core/errors.js";
import { isSafeStaleCallerObservationRecovery } from "../../src/core/run-status.js";
import { initialRunState, reduceRunState } from "../../src/core/state-machine.js";
import { loadPersistedRunStore } from "../../src/core/persisted-run.js";
import { JobStatusStore } from "../../src/jobs/status.js";
import type { ControllerJobSpec } from "../../src/protocol/types.js";
import { readEvents } from "../../src/state/event-log.js";
import { runPaths } from "../../src/state/paths.js";
import { RunStore } from "../../src/state/store.js";
import { FakeBrowserAdapter } from "../fakes/fake-browser.js";
import { submittedTurnWedgeFixture } from "../fixtures/submitted-turn-wedge.js";

const DEAD_PID = 2_147_483_647;

type SubmittedTurnObservation = BrowserSubmittedTurnObservation;

interface SubmittedObservationBrowser extends BrowserAdapter {
  observeSubmittedTurn(input: BrowserTurnInput): Promise<SubmittedTurnObservation>;
}

interface MisdirectedObservationBrowser extends BrowserAdapter {
  observeMisdirectedTurn(
    input: BrowserMisdirectedTurnObservationInput,
  ): Promise<BrowserMisdirectedTurnObservation>;
}

interface MisdirectedFixture {
  runId: string;
  requestId: string;
  round: number;
  priorRound: number;
  priorRequestId: string;
  prompt: string;
  conversationUrl: string;
  misdirectedConversationUrl: string;
  baselineUserMessageCount: number;
}

async function temporaryHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "cueline-lifecycle-"));
}

async function createMisdirectedSubmittedWedge(
  home: string,
  suffix: string,
): Promise<MisdirectedFixture> {
  const runId = `run_misdirected_${suffix}`;
  const { requestId } = await createSubmittedTurnWedge(home, runId);
  const conversationUrl = submittedTurnWedgeFixture.conversationUrl;
  const misdirectedConversationUrl = `https://chatgpt.com/c/orphan-misdirected-${suffix}`;
  const store = await loadPersistedRunStore(home, runId);
  const turn = store.state.pendingControllerTurns.find(
    (candidate) => candidate.requestId === requestId,
  );
  assert.notEqual(turn, undefined);
  await store.append("run_failed", {
    code: "CONTROLLER_RECONCILIATION_CONVERSATION_MISMATCH",
    request_id: requestId,
    stage: "controller_turn",
    submission_state: "submitted",
    message: "submitted checkpoint conversation mismatch",
  });
  await store.snapshot();
  const events = await readEvents(runPaths(home, runId).events);
  const prior = events
    .filter((event) => event.type === "controller_command_accepted")
    .map((event) => {
      const payload = event.payload as Record<string, unknown>;
      return payload.command as Record<string, unknown>;
    })
    .filter(
      (command) =>
        typeof command.round === "number" &&
        turn !== undefined &&
        command.round < turn.round,
    )
    .at(-1);
  if (typeof prior?.round !== "number" || typeof prior.request_id !== "string") {
    throw new Error("misdirected fixture missing prior accepted controller identity");
  }
  return {
    runId,
    requestId,
    round: turn!.round,
    priorRound: prior.round,
    priorRequestId: prior.request_id,
    prompt: turn!.prompt,
    conversationUrl,
    misdirectedConversationUrl,
    baselineUserMessageCount: turn!.baselineUserMessageCount ?? 0,
  };
}

function misdirectedObservationBrowser(
  fixture: MisdirectedFixture,
  observation: BrowserMisdirectedTurnObservation,
  options: { allowRetrySubmit?: boolean } = {},
): MisdirectedObservationBrowser & { submitCalls: number; observedInputs: unknown[] } {
  let submitCalls = 0;
  const observedInputs: unknown[] = [];
  return {
    submissionCheckpointContract: "write_ahead_v1",
    get submitCalls() {
      return submitCalls;
    },
    observedInputs,
    async observeMisdirectedTurn(input): Promise<BrowserMisdirectedTurnObservation> {
      observedInputs.push(input);
      assert.equal(input.runId, fixture.runId);
      assert.equal(input.round, fixture.round);
      assert.equal(input.requestId, fixture.requestId);
      assert.equal(input.prompt, fixture.prompt);
      assert.equal(input.expectedConversationUrl, fixture.conversationUrl);
      assert.equal(input.misdirectedConversationUrl, fixture.misdirectedConversationUrl);
      assert.equal(input.expectedPriorRound, fixture.priorRound);
      assert.equal(input.expectedPriorRequestId, fixture.priorRequestId);
      return observation;
    },
    async observeTurn(): Promise<undefined> {
      return undefined;
    },
    async submitTurn(input, hooks?: BrowserTurnHooks): Promise<void> {
      if (options.allowRetrySubmit !== true) {
        throw new Error("misdirected reconciliation test must not submit");
      }
      submitCalls += 1;
      assert.equal(input.runId, fixture.runId);
      assert.equal(input.round, fixture.round);
      assert.equal(input.notSentRecovery?.abandonedRequestId, fixture.requestId);
      assert.equal(input.expectedConversationUrl, fixture.conversationUrl);
      await hooks?.onCheckpoint?.({
        submissionState: "submitting",
        composerPromptState: "attachment_ready",
        conversationUrl: fixture.conversationUrl,
        selectedModelLabel: "Pro",
        baselineAssistantMessageCount: fixture.round,
        baselineUserMessageCount: fixture.baselineUserMessageCount,
        requestId: input.requestId,
        round: input.round,
        runId: input.runId,
        promptHash: commandHash(input.prompt),
      });
      await hooks?.onCheckpoint?.({
        submissionState: "submitted",
        composerPromptState: "attachment_ready",
        conversationUrl: fixture.conversationUrl,
        selectedModelLabel: "Pro",
        baselineAssistantMessageCount: fixture.round,
        baselineUserMessageCount: fixture.baselineUserMessageCount,
        requestId: input.requestId,
        round: input.round,
        runId: input.runId,
        promptHash: commandHash(input.prompt),
      });
    },
    async sendTurn(): Promise<ControllerTurn> {
      throw new Error("misdirected reconciliation must not use sendTurn");
    },
  };
}

function confirmedMisdirectedObservation(
  fixture: MisdirectedFixture,
  overrides: Partial<BrowserMisdirectedTurnObservation["evidence"]> = {},
): BrowserMisdirectedTurnObservation {
  const evidence = {
    misdirectedConversationUrl: fixture.misdirectedConversationUrl,
    boundConversationUrl: fixture.conversationUrl,
    selectedModelLabel: "Pro",
    misdirected: {
      pageUrl: fixture.misdirectedConversationUrl,
      isAnswering: false,
      assistantMessageCount: fixture.round,
      exactEnvelopeFound: true,
    },
    bound: {
      pageUrl: fixture.conversationUrl,
      isAnswering: false,
      userMessageCount: fixture.baselineUserMessageCount,
      assistantMessageCount: fixture.priorRound,
      requestMessageFound: false,
      priorEnvelopeFound: true,
    },
    ...overrides,
  };
  return { status: "confirmed", evidence };
}

async function createSubmittedTurnWedge(
  home: string,
  runId: string = submittedTurnWedgeFixture.fixtureRunId,
): Promise<{ requestId: string }> {
  const fixture = submittedTurnWedgeFixture;
  const store = await RunStore.create({
    home,
    runId,
    initialState: initialRunState(runId, fixture.prompt, "caller", 40),
    reducer: reduceRunState,
  });
  await store.append("run_created", {
    request: fixture.prompt,
    executor: "caller",
    max_rounds: 40,
  });
  await store.append("controller_turn_requested", {
    round: fixture.staleReconciliation.round,
    request_id: fixture.staleReconciliation.abandonedRequestId,
    prompt: "stale round 11 prompt",
    prompt_hash: commandHash("stale round 11 prompt"),
  });
  await store.append("controller_turn_not_sent_confirmed", {
    round: fixture.staleReconciliation.round,
    request_id: fixture.staleReconciliation.abandonedRequestId,
    prompt_hash: commandHash("stale round 11 prompt"),
    conversation_url: fixture.conversationUrl,
    selected_model_label: "Pro",
    baseline_user_message_count: 10,
    operator_confirmation: true,
  });
  await store.append("controller_turn_abandoned", {
    round: fixture.staleReconciliation.round,
    request_id: fixture.staleReconciliation.abandonedRequestId,
    reason: "operator_confirmed_not_sent",
    round_not_consumed: true,
    prompt_hash: commandHash("stale round 11 prompt"),
    conversation_url: fixture.conversationUrl,
    selected_model_label: "Pro",
    baseline_user_message_count: 10,
    operator_confirmation: true,
  });
  await store.append("controller_turn_requested", {
    round: fixture.staleReconciliation.round,
    request_id: fixture.staleReconciliation.retryRequestId,
    prompt: "stale round 11 retry prompt",
    prompt_hash: commandHash("stale round 11 retry prompt"),
    retry_of_request_id: fixture.staleReconciliation.abandonedRequestId,
  });
  await store.append("controller_command_accepted", {
    command_hash: "stale-round-11-command-hash",
    command: {
      protocol: "cueline/0.1",
      run_id: runId,
      round: fixture.staleReconciliation.round,
      request_id: fixture.staleReconciliation.retryRequestId,
      action: "wait",
    },
  });
  await store.append("controller_command_execution_completed", {
    command_hash: "stale-round-11-command-hash",
  });
  await store.append("controller_turn_requested", {
    round: fixture.priorVisibleRound,
    request_id: "msg_fixture_prior_visible_round",
    prompt: "round 33 prompt",
    prompt_hash: commandHash("round 33 prompt"),
  });
  await store.append("controller_turn_abandoned", {
    round: fixture.priorVisibleRound,
    request_id: "msg_fixture_prior_visible_round",
    reason: "fixture_prior_round_already_complete",
  });
  await store.snapshot();
  let requestId = "";
  const setupBrowser: BrowserAdapter = {
    submissionCheckpointContract: "write_ahead_v1",
    async submitTurn(input, hooks): Promise<void> {
      requestId = input.requestId;
      await hooks?.onCheckpoint?.({
        submissionState: "submitting",
        composerPromptState: "inline_ready",
        conversationUrl: fixture.conversationUrl,
        selectedModelLabel: "Pro",
        baselineUserMessageCount: fixture.baselineUserMessageCount,
        baselineAssistantMessageCount: 49,
        clickAttemptState: "attempting",
      });
      await hooks?.onCheckpoint?.({
        submissionState: "submitted",
        composerPromptState: "inline_ready",
        conversationUrl: fixture.conversationUrl,
        selectedModelLabel: "Pro",
        baselineUserMessageCount: fixture.baselineUserMessageCount,
        baselineAssistantMessageCount: 49,
        clickAttemptState: "accepted",
      });
    },
    async observeTurn(): Promise<undefined> {
      return undefined;
    },
    async sendTurn(): Promise<ControllerTurn> {
      throw new Error("field wedge setup must pause after submitted checkpoint");
    },
  };
  const seeded = await continueCueLineRun({
    runId,
    home,
    browser: setupBrowser,
    conversationUrl: fixture.conversationUrl,
    routingConfig,
  });
  assert.equal(seeded.status, "awaiting_controller");
  assert.notEqual(requestId, "");
  return { requestId };
}

async function createSubmissionStartedAttachmentWedge(
  home: string,
  suffix: string,
): Promise<{
  runId: string;
  requestId: string;
  conversationUrl: string;
  prompt: string;
  baselineUserMessageCount: number;
}> {
  const runId = `run_submission_started_${suffix}`;
  const requestId = `msg_submission_started_${suffix}`;
  const conversationUrl = `https://chatgpt.com/c/submission-started-${suffix}`;
  const prompt = `Attachment-backed submission-started recovery ${suffix}`;
  const baselineUserMessageCount = 101;
  const store = await RunStore.create({
    home,
    runId,
    initialState: initialRunState(runId, prompt, "caller", 100),
    reducer: reduceRunState,
  });
  await store.append("run_created", {
    request: prompt,
    executor: "caller",
    max_rounds: 100,
  });
  await store.append("controller_turn_requested", {
    round: 85,
    request_id: requestId,
    prompt,
    prompt_hash: commandHash(prompt),
    submission_checkpoint_contract: "write_ahead_v1",
  });
  await store.append("controller_turn_submission_started", {
    round: 85,
    request_id: requestId,
    submission_state: "submitting",
    conversation_url: conversationUrl,
    selected_model_label: "Pro",
    prompt_hash: commandHash(prompt),
    model_evidence_source: "composer",
    composer_prompt_state: "attachment_ready",
    baseline_user_message_count: baselineUserMessageCount,
    baseline_assistant_message_count: 16,
    click_attempt_state: "attempting",
  });
  await store.snapshot();
  return { runId, requestId, conversationUrl, prompt, baselineUserMessageCount };
}

async function createRound134LiveNoopWedge(home: string): Promise<{
  runId: string;
  requestId: string;
  conversationUrl: string;
  prompt: string;
}> {
  const runId = "run_2707dc7332cd6d6f9c5c3d5cf21a33fd";
  const requestId = "msg_71c4a00e01b7a719f831b92ef2f61411";
  const conversationUrl = "https://chatgpt.com/c/6a5a679d-dd68-83ee-becb-7b7705ce886e";
  const prompt = `Round 134 staged controller prompt ${requestId}`;
  const promptHash = commandHash(prompt);
  const store = await RunStore.create({
    home,
    runId,
    initialState: { ...initialRunState(runId, prompt, "caller", 200), round: 133 },
    reducer: reduceRunState,
  });
  await store.append("run_created", { request: prompt, executor: "caller", max_rounds: 200 });
  const liveEvents = [
    [2459, "controller_turn_requested", { round: 134, request_id: requestId, prompt, prompt_hash: promptHash, submission_checkpoint_contract: "write_ahead_v1" }],
    [2460, "controller_turn_prompt_staged", { round: 134, request_id: requestId, conversation_url: conversationUrl, selected_model_label: "Pro", composer_prompt_state: "attachment_ready", baseline_user_message_count: 0, baseline_assistant_message_count: 0 }],
    [2461, "controller_turn_submission_started", { round: 134, request_id: requestId, submission_state: "submitting", conversation_url: conversationUrl, selected_model_label: "Pro", composer_prompt_state: "attachment_ready", baseline_user_message_count: 0, baseline_assistant_message_count: 0 }],
    [2462, "run_failed", { code: "CONTROLLER_PROMPT_NOT_SENT", request_id: requestId, stage: "controller_turn", submission_state: "definitely_not_sent", conversation_url: conversationUrl }],
    [2463, "controller_turn_not_sent_confirmed", { round: 134, request_id: requestId, prompt_hash: promptHash, conversation_url: conversationUrl, selected_model_label: "Pro", baseline_user_message_count: 0, observed_user_message_count: 0, composer_prompt_state: "attachment_ready", submission_state: "definitely_not_sent", confirmation_source: "fresh_read_only_observation" }],
    [2464, "controller_turn_abandoned", { round: 134, request_id: requestId, reason: "operator_confirmed_not_sent", round_not_consumed: true, prompt_hash: promptHash, conversation_url: conversationUrl, selected_model_label: "Pro", baseline_user_message_count: 0, composer_prompt_state: "attachment_ready" }],
    [2465, "run_resumed", { previous_status: "failed" }],
    [2466, "controller_conversation_bound", { conversation_url: conversationUrl }],
    [2467, "controller_turn_requested", { round: 134, request_id: requestId, prompt, prompt_hash: promptHash, retry_of_request_id: requestId, recovery_prompt_hash: promptHash, submission_checkpoint_contract: "write_ahead_v1" }],
    [2468, "controller_turn_prompt_staged", { round: 134, request_id: requestId, conversation_url: conversationUrl, selected_model_label: "Pro", composer_prompt_state: "attachment_ready", baseline_user_message_count: 0, baseline_assistant_message_count: 0 }],
    [2469, "controller_turn_submission_started", { round: 134, request_id: requestId, submission_state: "submitting", conversation_url: conversationUrl, selected_model_label: "Pro", composer_prompt_state: "attachment_ready", baseline_user_message_count: 0, baseline_assistant_message_count: 0 }],
    [2470, "run_failed", { code: "CONTROLLER_PROMPT_NOT_SENT", request_id: requestId, stage: "controller_turn", submission_state: "definitely_not_sent", conversation_url: conversationUrl }],
    [2471, "controller_turn_post_fix_retry_reauthorized", { round: 134, request_id: requestId, prompt_hash: promptHash, conversation_url: conversationUrl, failure_code: "CONTROLLER_PROMPT_NOT_SENT", submission_state: "definitely_not_sent", not_sent_recovery_status: "retry_pending", composer_prompt_state: "attachment_ready", composer_attachment_count: 1, composer_attachment_kind: "pasted_text", baseline_user_message_count: 0, observed_user_message_count: 0, selected_model_label: "Pro", confirmation_source: "fresh_read_only_observation", one_shot: true }],
    [2472, "controller_turn_abandoned", { round: 134, request_id: requestId, reason: "post_fix_retry_reauthorized", round_not_consumed: true }],
    [2473, "run_resumed", { previous_status: "failed" }],
    [2474, "controller_conversation_bound", { conversation_url: conversationUrl }],
    [2475, "controller_turn_requested", { round: 134, request_id: requestId, prompt, prompt_hash: promptHash, retry_of_request_id: requestId, recovery_prompt_hash: promptHash, post_fix_retry_reauthorized: true, submission_checkpoint_contract: "write_ahead_v1" }],
    [2476, "controller_turn_prompt_staged", { round: 134, request_id: requestId, conversation_url: conversationUrl, selected_model_label: "Pro", composer_prompt_state: "attachment_ready", baseline_user_message_count: 0, baseline_assistant_message_count: 0 }],
    [2477, "controller_turn_submission_started", { round: 134, request_id: requestId, submission_state: "submitting", conversation_url: conversationUrl, selected_model_label: "Pro", composer_prompt_state: "attachment_ready", baseline_user_message_count: 0, baseline_assistant_message_count: 0 }],
    [2478, "run_failed", { code: "CONTROLLER_PROMPT_NOT_SENT", request_id: requestId, stage: "controller_turn", submission_state: "definitely_not_sent", conversation_url: conversationUrl }],
  ] as const;
  for (const [sourceSequence, type, payload] of liveEvents) {
    await store.append(type, { ...payload, source_event_sequence: sourceSequence });
  }
  await store.snapshot();
  return { runId, requestId, conversationUrl, prompt };
}

function submittedObservationBrowser(
  observation: SubmittedTurnObservation,
  options: { allowRetrySubmit?: boolean } = {},
): SubmittedObservationBrowser & { submitCalls: number } {
  let submitCalls = 0;
  return {
    submissionCheckpointContract: "write_ahead_v1",
    get submitCalls() {
      return submitCalls;
    },
    async observeSubmittedTurn(): Promise<SubmittedTurnObservation> {
      return observation;
    },
    async observeTurn(): Promise<undefined> {
      return undefined;
    },
    async submitTurn(input, hooks?: BrowserTurnHooks): Promise<void> {
      if (options.allowRetrySubmit !== true) {
        throw new Error("submitted wedge recovery must not create a retry");
      }
      submitCalls += 1;
      await hooks?.onCheckpoint?.({
        submissionState: "submitting",
        composerPromptState: "inline_ready",
        conversationUrl: submittedTurnWedgeFixture.conversationUrl,
        selectedModelLabel: "Pro",
        baselineUserMessageCount: submittedTurnWedgeFixture.baselineUserMessageCount,
        baselineAssistantMessageCount: 49,
        clickAttemptState: "attempting",
      });
      await hooks?.onCheckpoint?.({
        submissionState: "submitted",
        composerPromptState: "inline_ready",
        conversationUrl: submittedTurnWedgeFixture.conversationUrl,
        selectedModelLabel: "Pro",
        baselineUserMessageCount: submittedTurnWedgeFixture.baselineUserMessageCount,
        baselineAssistantMessageCount: 49,
        clickAttemptState: "accepted",
      });
      assert.notEqual(input.requestId, "");
    },
    async sendTurn(): Promise<ControllerTurn> {
      throw new Error("caller recovery must use submitTurn exactly once");
    },
  };
}

function definitelyNotSentObservation(
  overrides: Partial<BrowserSubmittedTurnEvidence> = {},
): SubmittedTurnObservation {
  return {
    status: "definitely_not_sent",
    evidence: {
      conversationUrl: submittedTurnWedgeFixture.conversationUrl,
      selectedModelLabel: "Pro",
      hydrated: true,
      baselineUserMessageCount: submittedTurnWedgeFixture.baselineUserMessageCount,
      observedUserMessageCount: submittedTurnWedgeFixture.baselineUserMessageCount,
      requestMessageFound: false,
      isAnswering: false,
      composerPromptState: "inline_ready",
      composerAttachmentCount: 0,
      composerSendButtonEnabled: true,
      ...overrides,
    },
  };
}

function completeReply(
  input: BrowserTurnInput,
  finalDeliveryText: string,
): ControllerTurn {
  return {
    text: `<CueLineControl>${JSON.stringify({
      protocol: "cueline/0.1",
      run_id: input.runId,
      round: input.round,
      request_id: input.requestId,
      action: "complete",
      final_delivery_text: finalDeliveryText,
    })}</CueLineControl>`,
    conversationUrl: "https://chatgpt.com/c/lifecycle-recovery",
    model: {
      provider: "chatgpt",
      selectedLabel: "Pro",
      responseModelSlug: "gpt-5-6-pro",
      source: "composer_and_response",
    },
  };
}

async function createJobRun(
  home: string,
  runId: string,
  executor: "caller" | "process",
  options: {
    failed?: boolean;
    persistedStatus?: "pending" | "running";
    maxJobEvidenceChars?: number;
  } = {},
): Promise<{
  jobId: string;
  spec: ControllerJobSpec;
  store: RunStore<ReturnType<typeof initialRunState>>;
}> {
  const spec: ControllerJobSpec = {
    job_key: "lifecycle_job",
    lane: "default",
    mode: "advise",
    task: "Prove lifecycle convergence",
  };
  const id = jobId(runId, spec.job_key, spec);
  const store = await RunStore.create({
    home,
    runId,
    initialState: initialRunState(
      runId,
      "",
      executor,
      12,
      executor === "process",
      false,
      options.maxJobEvidenceChars,
    ),
    reducer: reduceRunState,
  });
  await store.append("run_created", {
    request: "Exercise lifecycle recovery",
    executor,
    ...(executor === "process" ? { allow_process_execution: true } : {}),
    ...(options.maxJobEvidenceChars === undefined
      ? {}
      : { max_job_evidence_chars: options.maxJobEvidenceChars }),
  });
  await store.append("job_registered", {
    job: {
      jobId: id,
      jobKey: spec.job_key,
      required: true,
      spec,
      status: options.persistedStatus ?? "running",
      output: null,
      error: null,
    },
  });
  if (options.failed) {
    await store.append("run_failed", {
      code: "OUTER_OWNER_DIED",
      message: "The outer owner disappeared before job convergence.",
      stage: "controller_loop",
    });
  }
  await store.snapshot();
  await new JobStatusStore(home).write({
    jobId: id,
    runId,
    jobKey: spec.job_key,
    lane: spec.lane,
    mode: spec.mode,
    ...(executor === "process" ? { pid: DEAD_PID } : {}),
    execution: "foreground",
    status: options.persistedStatus ?? "running",
    startedAt: "2026-07-15T00:00:00.000Z",
  });
  return { jobId: id, spec, store };
}

async function writeDeadLease(
  home: string,
  runId: string,
  ownership: "active" | "stale",
): Promise<void> {
  const timestamp =
    ownership === "active"
      ? new Date().toISOString()
      : "2026-07-14T00:00:00.000Z";
  await writeFile(
    runPaths(home, runId).runtimeLease,
    `${JSON.stringify({
      protocol: "cueline/runtime-lease/0.1",
      run_id: runId,
      owner_id: "definitely-dead-owner",
      pid: String(DEAD_PID),
      state: "active",
      claimed_at: timestamp,
      heartbeat_at: timestamp,
    })}\n`,
    "utf8",
  );
}

function succeededStatus(
  runId: string,
  jobIdValue: string,
  spec: ControllerJobSpec,
  output: string,
) {
  const timestamp = "2026-07-15T00:00:01.000Z";
  return {
    jobId: jobIdValue,
    runId,
    jobKey: spec.job_key,
    lane: spec.lane,
    mode: spec.mode,
    pid: DEAD_PID,
    execution: "foreground" as const,
    status: "succeeded" as const,
    startedAt: timestamp,
    finishedAt: timestamp,
    result: {
      status: "succeeded" as const,
      exitCode: 0,
      stdout: output,
      stderr: "",
      output,
      emptyOutput: false,
      timedOut: false,
      cancelled: false,
      ambiguousSideEffects: false,
      retryable: false as const,
      startedAt: timestamp,
      finishedAt: timestamp,
    },
  };
}

const routingConfig = {
  version: 1 as const,
  lanes: {
    default: {
      enabled: true,
      candidates: [
        {
          id: "node",
          argv: [process.execPath, "-e", "process.stdout.write('unused')"],
          task_input: "stdin" as const,
        },
      ],
    },
  },
};

const legacyAdapterFailureConversationUrl =
  "https://chatgpt.com/c/legacy-pre-submission-adapter-failure";

async function createLegacyPreSubmissionAdapterFailure(
  home: string,
  runId: string,
  options: { failureMessage?: string } = {},
): Promise<{ requestId: string; prompt: string }> {
  let requestId = "";
  let prompt = "";
  const userRequest = `legacy request ${runId}`;
  const store = await RunStore.create({
    home,
    runId,
    initialState: {
      ...initialRunState(runId, userRequest, "caller", 200),
      round: 67,
    },
    reducer: reduceRunState,
  });
  await store.append("run_created", {
    request: userRequest,
    executor: "caller",
    max_rounds: 200,
  });
  await store.append("controller_turn_requested", {
    round: 67,
    request_id: "msg_legacy_prior_round",
    prompt: "prior round prompt",
    prompt_hash: commandHash("prior round prompt"),
  });
  await store.append("controller_command_accepted", {
    command_hash: "legacy-prior-command",
    command: {
      protocol: "cueline/0.1",
      run_id: runId,
      round: 67,
      request_id: "msg_legacy_prior_round",
      action: "wait",
    },
  });
  await store.append("controller_command_execution_completed", {
    command_hash: "legacy-prior-command",
  });
  await store.append("controller_conversation_bound", {
    conversation_url: legacyAdapterFailureConversationUrl,
  });
  await store.snapshot();
  const failingBrowser: BrowserAdapter = {
    async sendTurn(input): Promise<ControllerTurn> {
      requestId = input.requestId;
      prompt = input.prompt;
      throw new TypeError(options.failureMessage ?? "browser.sendTurn is not a function");
    },
  };
  await assert.rejects(
    continueCueLineRun({ runId, home, browser: failingBrowser, routingConfig }),
  );
  assert.notEqual(requestId, "");
  const failedStore = await RunStore.load({
    home,
    runId,
    initialState: initialRunState(runId, userRequest, "caller", 200),
    reducer: reduceRunState,
  });
  await failedStore.append("run_resumed", {});
  await failedStore.append("run_failed", {
    code: "CONTROLLER_RECONCILIATION_MISMATCH",
    message: "last user mismatch",
    request_id: requestId,
    stage: "reconciling",
    submission_state: "possibly_sent",
  });
  await failedStore.snapshot();
  return { requestId, prompt };
}

function legacyObservationBrowser(
  overrides: Partial<BrowserSubmittedTurnEvidence> = {},
): BrowserAdapter & {
  confirmationCalls: number;
  submitCalls: number;
  submittedRequestIds: string[];
} {
  let confirmationCalls = 0;
  let submitCalls = 0;
  const submittedRequestIds: string[] = [];
  return {
    submissionCheckpointContract: "write_ahead_v1",
    get confirmationCalls() {
      return confirmationCalls;
    },
    get submitCalls() {
      return submitCalls;
    },
    submittedRequestIds,
    async observeSubmittedTurn(input) {
      confirmationCalls += 1;
      assert.equal(
        (input as BrowserTurnInput & { legacyPreSubmissionRecovery?: boolean })
          .legacyPreSubmissionRecovery,
        true,
      );
      return {
        status: "definitely_not_sent",
        evidence: {
          conversationUrl: legacyAdapterFailureConversationUrl,
          selectedModelLabel: "Pro",
          hydrated: true,
          baselineUserMessageCount: 67,
          observedUserMessageCount: 67,
          requestMessageFound: false,
          isAnswering: false,
          ...overrides,
        },
      };
    },
    async submitTurn(input, hooks) {
      submitCalls += 1;
      submittedRequestIds.push(input.requestId);
      await hooks?.onCheckpoint?.({
        submissionState: "submitted",
        composerPromptState: "inline_ready",
        conversationUrl: legacyAdapterFailureConversationUrl,
        selectedModelLabel: "Pro",
        baselineUserMessageCount: 67,
        baselineAssistantMessageCount: 67,
      });
    },
    async observeTurn() {
      return undefined;
    },
    async sendTurn(): Promise<ControllerTurn> {
      throw new Error("caller continuation must use split submission");
    },
  };
}

test("continueCueLineRun rejects invalid browser adapters before durable mutation", async () => {
  const cases: Array<{ name: string; browser: unknown; missingMethods: string[] }> = [
    {
      name: "built-in-iab-module",
      browser: { browserId: "iab", tabs: [], user: {} },
      missingMethods: ["sendTurn"],
    },
    {
      name: "undefined-send-turn",
      browser: { sendTurn: undefined },
      missingMethods: ["sendTurn"],
    },
    {
      name: "non-function-send-turn",
      browser: { sendTurn: "not-a-function" },
      missingMethods: ["sendTurn"],
    },
    {
      name: "submit-without-observe",
      browser: { sendTurn() {}, submitTurn() {} },
      missingMethods: ["observeTurn"],
    },
    {
      name: "observe-without-submit",
      browser: { sendTurn() {}, observeTurn() {} },
      missingMethods: ["submitTurn"],
    },
  ];

  for (const fixture of cases) {
    const home = await temporaryHome();
    const runId = `run_invalid_browser_${fixture.name}`;
    await startCueLineRun({ request: "adapter preflight", runId, home });
    const beforeEvents = await readEvents(runPaths(home, runId).events);
    const beforeState = await loadCueLineRunState(runId, { home });

    await assert.rejects(
      continueCueLineRun({
        runId,
        home,
        browser: fixture.browser as BrowserAdapter,
        routingConfig,
      }),
      (error: unknown) => {
        const actual = error as { code?: string; details?: unknown };
        assert.equal(actual.code, "BROWSER_ADAPTER_INVALID", fixture.name);
        assert.deepEqual(
          actual.details,
          { missingMethods: fixture.missingMethods },
          fixture.name,
        );
        return true;
      },
    );

    const afterEvents = await readEvents(runPaths(home, runId).events);
    const afterState = await loadCueLineRunState(runId, { home });
    assert.equal(afterEvents.length, beforeEvents.length, fixture.name);
    assert.equal(afterState.round, beforeState.round, fixture.name);
    assert.equal(
      afterState.pendingControllerTurns.length,
      beforeState.pendingControllerTurns.length,
      fixture.name,
    );
    assert.deepEqual(afterState.commandHashes, beforeState.commandHashes, fixture.name);
  }
});

test("legacy pre-submission adapter failure is abandoned once and retried once", async () => {
  const home = await temporaryHome();
  const runId = "run_legacy_pre_submission_adapter_failure";
  const { requestId } = await createLegacyPreSubmissionAdapterFailure(home, runId);
  const browser = legacyObservationBrowser();

  const confirmation = await confirmControllerTurnNotSent(runId, {
    home,
    requestId,
    browser,
  });
  assert.equal(confirmation.outcome, "confirmed");
  assert.equal(browser.confirmationCalls, 1);

  const repeatedConfirmation = await confirmControllerTurnNotSent(runId, {
    home,
    requestId,
    browser,
  });
  assert.equal(repeatedConfirmation.outcome, "already_confirmed");
  assert.equal(browser.confirmationCalls, 1);

  const first = await continueCueLineRun({
    runId,
    home,
    browser,
    routingConfig,
  });
  assert.equal(first.status, "awaiting_controller");
  assert.equal(browser.submitCalls, 1);
  assert.equal(browser.submittedRequestIds.length, 1);
  assert.notEqual(browser.submittedRequestIds[0], requestId);

  const second = await continueCueLineRun({
    runId,
    home,
    browser,
    routingConfig,
  });
  assert.equal(second.status, "awaiting_controller");
  assert.equal(browser.submitCalls, 1);

  const events = await readEvents(runPaths(home, runId).events);
  assert.equal(
    events.filter(
      (event) =>
        event.type === "controller_turn_not_sent_confirmed" &&
        (event.payload as Record<string, unknown>).request_id === requestId,
    ).length,
    1,
  );
  assert.equal(
    events.filter(
      (event) =>
        event.type === "controller_turn_abandoned" &&
        (event.payload as Record<string, unknown>).request_id === requestId &&
        (event.payload as Record<string, unknown>).reason ===
          "legacy_pre_submission_adapter_failure",
    ).length,
    1,
  );
  const retries = events.filter(
    (event) =>
      event.type === "controller_turn_requested" &&
      (event.payload as Record<string, unknown>).retry_of_request_id === requestId,
  );
  assert.equal(retries.length, 1);
  assert.equal(
    (retries[0]?.payload as Record<string, unknown>).request_id,
    browser.submittedRequestIds[0],
  );
  assert.equal(events.filter((event) => event.type === "job_registered").length, 0);
  assert.equal((await loadCueLineRunState(runId, { home })).round, 68);
});

test("legacy pre-submission recovery rejects missing or conflicting evidence", async () => {
  const fixtures: Array<{
    name: string;
    failureMessage?: string;
    observation?: Partial<BrowserSubmittedTurnEvidence>;
    append?: (store: RunStore<ReturnType<typeof initialRunState>>, requestId: string) => Promise<void>;
  }> = [
    {
      name: "generic-internal",
      failureMessage: "unrelated internal error",
    },
    {
      name: "request-found",
      observation: { requestMessageFound: true },
    },
    {
      name: "pro-answering",
      observation: { isAnswering: true },
    },
    {
      name: "conversation-mismatch",
      observation: { conversationUrl: "https://chatgpt.com/c/different-conversation" },
    },
    {
      name: "submission-checkpoint",
      append: async (store, requestId) => {
        await store.append("controller_turn_submission_started", {
          round: 68,
          request_id: requestId,
          submission_state: "submitting",
          selected_model_label: "Pro",
          baseline_assistant_message_count: 67,
          composer_prompt_state: "inline_ready",
        });
      },
    },
    {
      name: "response-received",
      append: async (store, requestId) => {
        await store.append("controller_response_received", {
          round: 68,
          request_id: requestId,
          text: "unaccepted response",
        });
      },
    },
    {
      name: "newer-command-accepted",
      append: async (store) => {
        await store.append("controller_command_accepted", {
          command_hash: "newer-command",
          command: {
            protocol: "cueline/0.1",
            run_id: store.state.runId,
            round: 68,
            request_id: "msg_other_same_round",
            action: "wait",
          },
        });
      },
    },
  ];

  for (const fixture of fixtures) {
    const home = await temporaryHome();
    const runId = `run_legacy_reject_${fixture.name}`;
    const { requestId } = await createLegacyPreSubmissionAdapterFailure(home, runId, {
      ...(fixture.failureMessage === undefined
        ? {}
        : { failureMessage: fixture.failureMessage }),
    });
    if (fixture.append !== undefined) {
      const store = await RunStore.load({
        home,
        runId,
        initialState: initialRunState(runId, "", "caller", 200),
        reducer: reduceRunState,
      });
      await fixture.append(store, requestId);
      await store.snapshot();
    }
    const browser = legacyObservationBrowser(fixture.observation);

    await assert.rejects(
      confirmControllerTurnNotSent(runId, { home, requestId, browser }),
      (error: unknown) => {
        assert.match(
          String((error as { code?: string }).code),
          /^CONTROLLER_(?:NOT_SENT|RECONCILIATION)_/,
          fixture.name,
        );
        return true;
      },
    );
    const state = await loadCueLineRunState(runId, { home });
    assert.equal(state.notSentRecovery, null, fixture.name);
    assert.equal(state.pendingControllerTurns.length, 1, fixture.name);
  }
});

test("run cancellation retires a fresh lease whose PID is definitely dead", async () => {
  const home = await temporaryHome();
  const runId = "run_cancel_fresh_dead_owner";
  const fixture = await createJobRun(home, runId, "process");
  await writeDeadLease(home, runId, "active");

  const result = await cancelCueLineRun(runId, { home });

  assert.equal(result.outcome, "cancelled");
  assert.equal(result.affectedJobs, 1);
  assert.equal((await new JobStatusStore(home).read(fixture.jobId))?.status, "ambiguous");
  assert.equal((await loadCueLineRunStatus(runId, { home })).status, "cancelled");
});

test("job cancellation retires a stale lease whose PID is definitely dead", async () => {
  const home = await temporaryHome();
  const runId = "run_job_cancel_fresh_dead_owner";
  const fixture = await createJobRun(home, runId, "process");
  await writeDeadLease(home, runId, "stale");

  const result = await cancelCueLineJob(runId, fixture.jobId, { home });

  assert.equal(result.outcome, "ambiguous");
  assert.equal((await new JobStatusStore(home).read(fixture.jobId))?.status, "ambiguous");
});

test("ownerless cancellation stays pending while the persisted process group is alive", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process-group liveness is required");
    return;
  }
  const home = await temporaryHome();
  const runId = "run_cancel_live_ownerless_group";
  const fixture = await createJobRun(home, runId, "process");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
    detached: true,
    stdio: "ignore",
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("detached test process has no PID");
  child.unref();
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  await new JobStatusStore(home).write({
    jobId: fixture.jobId,
    runId,
    jobKey: fixture.spec.job_key,
    lane: fixture.spec.lane,
    mode: fixture.spec.mode,
    pid,
    execution: "background",
    status: "running",
    startedAt: "2026-07-15T00:00:00.000Z",
  });

  try {
    const result = await cancelCueLineRun(runId, { home });
    assert.deepEqual(result, { runId, outcome: "requested", affectedJobs: 0 });
    const state = await loadCueLineRunStatus(runId, { home });
    assert.equal(state.status, "running");
    const persisted = await new JobStatusStore(home).read(fixture.jobId);
    assert.equal(persisted?.status, "running");
    assert.equal(persisted?.pid, pid);
    assert.doesNotThrow(() => process.kill(-pid, 0));
  } finally {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The child may have exited independently; cleanup remains best effort.
    }
  }
});

test("explicit stale takeover releases a shared live-host owner, audits it, and permits caller continuation", async () => {
  const home = await temporaryHome();
  const runId = "run_explicit_stale_takeover";
  const store = await RunStore.create({
    home,
    runId,
    initialState: initialRunState(runId, "", "caller"),
    reducer: reduceRunState,
  });
  await store.append("run_created", {
    request: "Resume after a shared Node host lost the outer caller",
    executor: "caller",
  });
  const heartbeatAt = "2026-07-15T00:00:00.000Z";
  await writeFile(
    runPaths(home, runId).runtimeLease,
    `${JSON.stringify({
      protocol: "cueline/runtime-lease/0.1",
      run_id: runId,
      owner_id: "shared-live-host-owner",
      pid: String(process.pid),
      state: "active",
      claimed_at: heartbeatAt,
      heartbeat_at: heartbeatAt,
    })}\n`,
    "utf8",
  );
  const now = () => new Date("2026-07-15T00:01:00.000Z");

  const takeover = await takeoverCueLineRuntime(runId, { home, now });

  assert.equal(takeover.outcome, "taken_over");
  assert.equal(takeover.next, "continue");
  assert.equal((await loadCueLineRunStatus(runId, { home, now })).runtime.ownership, "missing");
  const events = await readEvents(runPaths(home, runId).events);
  assert.deepEqual(
    events
      .filter((event) => event.type.startsWith("runtime_stale_owner_takeover_"))
      .map((event) => event.type),
    [
      "runtime_stale_owner_takeover_requested",
      "runtime_stale_owner_takeover_confirmed",
    ],
  );
  const result = await continueCueLineRun({
    runId,
    home,
    now,
    browser: new FakeBrowserAdapter([
      (input) => completeReply(input, "TAKEOVER_CONTINUED"),
    ]),
    routingConfig,
  });
  assert.equal(result.status, "complete");
  assert.equal(result.finalDeliveryText, "TAKEOVER_CONTINUED");
});

test("process takeover's advertised runtime reconciliation is executable before continuation", async () => {
  const home = await temporaryHome();
  const runId = "run_process_takeover_reconcile_continue";
  const store = await RunStore.create({
    home,
    runId,
    initialState: initialRunState(runId, "", "process", 12, true),
    reducer: reduceRunState,
  });
  await store.append("run_created", {
    request: "Resume a process run only after runtime reconciliation",
    executor: "process",
    allow_process_execution: true,
  });
  const heartbeatAt = "2026-07-15T00:00:00.000Z";
  await writeFile(
    runPaths(home, runId).runtimeLease,
    `${JSON.stringify({
      protocol: "cueline/runtime-lease/0.1",
      run_id: runId,
      owner_id: "lost-process-owner",
      pid: String(process.pid),
      state: "active",
      claimed_at: heartbeatAt,
      heartbeat_at: heartbeatAt,
    })}\n`,
    "utf8",
  );
  const now = () => new Date("2026-07-15T00:01:00.000Z");

  const takeover = await takeoverCueLineRuntime(runId, { home, now });
  assert.equal(takeover.outcome, "taken_over");
  assert.equal(takeover.next, "reconcile_runtime");

  const reconciled = await reconcileCueLineRuntime(runId, { home, now });
  assert.equal(reconciled.outcome, "reconciled");
  assert.equal(reconciled.affectedJobs, 0);

  const result = await continueCueLineRun({
    runId,
    home,
    now,
    browser: new FakeBrowserAdapter([
      (input) => completeReply(input, "PROCESS_TAKEOVER_CONTINUED"),
    ]),
    routingConfig,
    allowProcessExecution: true,
  });
  assert.equal(result.status, "complete");
  assert.equal(result.finalDeliveryText, "PROCESS_TAKEOVER_CONTINUED");
});

test("runtime reconciliation bounds terminal evidence copied from full job status", async () => {
  const home = await temporaryHome();
  const runId = "run_reconcile_bounded_terminal_evidence";
  const fixture = await createJobRun(home, runId, "process", {
    maxJobEvidenceChars: 4_000,
  });
  const stdout = `RECOVERED_STDOUT\n${"S".repeat(30_000)}`;
  const stderr = `RECOVERED_TRACE_SENTINEL\n${"T".repeat(150_000)}`;
  const error = `RECOVERED_ERROR\n${"E".repeat(40_000)}`;
  const persisted = succeededStatus(runId, fixture.jobId, fixture.spec, stdout);
  persisted.result.stderr = stderr;
  persisted.result.output = `${stdout}\n${stderr}`;
  const persistedWithError = { ...persisted, error };
  await new JobStatusStore(home).write(persistedWithError);

  const reconciled = await reconcileCueLineRuntime(runId, { home });

  assert.equal(reconciled.outcome, "reconciled");
  assert.equal(reconciled.affectedJobs, 1);
  const durableStatus = await new JobStatusStore(home).read(fixture.jobId);
  assert.equal(durableStatus?.result?.stdout, stdout);
  assert.equal(durableStatus?.result?.stderr, stderr);
  assert.equal(durableStatus?.error, error);
  const terminalEvent = (await readEvents(runPaths(home, runId).events)).findLast(
    (entry) =>
      entry.type === "job_status" &&
      typeof entry.payload === "object" &&
      entry.payload !== null &&
      !Array.isArray(entry.payload) &&
      (entry.payload as Record<string, unknown>).status === "succeeded",
  );
  const payload = terminalEvent?.payload as Record<string, unknown>;
  assert.equal(typeof payload.output, "string");
  assert.equal(typeof payload.error, "string");
  assert.match(payload.output as string, /RECOVERED_STDOUT/);
  assert.doesNotMatch(payload.output as string, /RECOVERED_TRACE_SENTINEL/);
  assert.match(payload.output as string, /\[job evidence capped: \d+ chars omitted;.*cap=4000\]$/);
  assert.match(payload.error as string, /\[job evidence capped: \d+ chars omitted;.*cap=4000\]$/);
  assert.equal(payload.output_total_chars, stdout.length);
  assert.equal(payload.error_total_chars, error.length);
  assert.ok((payload.output as string).length < 4_200);
  assert.ok((payload.error as string).length < 4_200);
});

test("runtime reconciliation refuses malformed job status without inventing a terminal state", async () => {
  const home = await temporaryHome();
  const runId = "run_reconcile_malformed_job_status";
  const fixture = await createJobRun(home, runId, "process");
  await writeFile(new JobStatusStore(home).pathFor(fixture.jobId), "{}\n", "utf8");
  const before = await readEvents(runPaths(home, runId).events);

  await assert.rejects(
    reconcileCueLineRuntime(runId, { home }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "JOB_STATUS_INVALID",
  );

  const after = await readEvents(runPaths(home, runId).events);
  assert.deepEqual(after, before);
  const state = await loadCueLineRunState(runId, { home });
  assert.equal(state.status, "running");
  assert.equal(state.jobs[fixture.jobId]?.status, "running");
});

test("concurrent explicit takeovers record attempts safely but only one confirmed success", async () => {
  const home = await temporaryHome();
  const runId = "run_concurrent_explicit_takeover";
  const store = await RunStore.create({
    home,
    runId,
    initialState: initialRunState(runId, "", "caller"),
    reducer: reduceRunState,
  });
  await store.append("run_created", {
    request: "Only one stale takeover may succeed",
    executor: "caller",
  });
  const heartbeatAt = "2026-07-15T00:00:00.000Z";
  await writeFile(
    runPaths(home, runId).runtimeLease,
    `${JSON.stringify({
      protocol: "cueline/runtime-lease/0.1",
      run_id: runId,
      owner_id: "concurrent-stale-owner",
      pid: String(process.pid),
      state: "active",
      claimed_at: heartbeatAt,
      heartbeat_at: heartbeatAt,
    })}\n`,
    "utf8",
  );
  const now = () => new Date("2026-07-15T00:01:00.000Z");

  const attempts = await Promise.allSettled([
    takeoverCueLineRuntime(runId, { home, now }),
    takeoverCueLineRuntime(runId, { home, now }),
  ]);

  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  const rejected = attempts.find(
    (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
  );
  assert.equal(
    rejected?.reason instanceof Error &&
      "code" in rejected.reason &&
      rejected.reason.code === "RUNTIME_TAKEOVER_RACE",
    true,
  );
  const events = await readEvents(runPaths(home, runId).events);
  assert.equal(
    events.filter((event) => event.type === "runtime_stale_owner_takeover_requested").length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === "runtime_stale_owner_takeover_confirmed").length,
    1,
  );
  assert.deepEqual(
    events.map((event) => event.sequence),
    Array.from({ length: events.length }, (_, index) => index + 1),
  );
  assert.equal(
    (
      await readdir(`${runPaths(home, runId).runtimeLease}.takeover-intents`)
    ).filter((name) => name.endsWith(".json")).length,
    2,
  );
});

test("run cancellation retry repairs a stale job status left by event-first interruption", async () => {
  const home = await temporaryHome();
  const runId = "run_cancel_repairs_status";
  const fixture = await createJobRun(home, runId, "caller", { persistedStatus: "pending" });
  const error = "Caller job was cancelled before execution evidence was submitted.";
  await fixture.store.append("job_status", {
    job_id: fixture.jobId,
    status: "cancelled",
    error,
  });
  await fixture.store.append("run_cancelled", { reason: "interrupted cancellation" });
  await fixture.store.snapshot();

  const result = await cancelCueLineRun(runId, { home });

  assert.equal(result.outcome, "already_terminal");
  const persisted = await new JobStatusStore(home).read(fixture.jobId);
  assert.equal(persisted?.status, "cancelled");
  assert.equal(persisted?.error, error);
});

test("job cancellation retry repairs a stale job status left by event-first interruption", async () => {
  const home = await temporaryHome();
  const runId = "run_job_cancel_repairs_status";
  const fixture = await createJobRun(home, runId, "caller", { persistedStatus: "pending" });
  const error = "Caller job was cancelled before execution evidence was submitted.";
  await fixture.store.append("job_status", {
    job_id: fixture.jobId,
    status: "cancelled",
    error,
  });
  await fixture.store.snapshot();

  const result = await cancelCueLineJob(runId, fixture.jobId, { home });

  assert.equal(result.outcome, "already_terminal");
  const persisted = await new JobStatusStore(home).read(fixture.jobId);
  assert.equal(persisted?.status, "cancelled");
  assert.equal(persisted?.error, error);
});

test("cancellation rejects blank reasons before writing an unreadable request", async () => {
  const home = await temporaryHome();
  const runId = "run_cancel_blank_reason";
  const fixture = await createJobRun(home, runId, "caller", { persistedStatus: "pending" });

  await assert.rejects(
    cancelCueLineRun(runId, { home, reason: "   " }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CANCELLATION_REASON_INVALID",
  );
  await assert.rejects(
    cancelCueLineJob(runId, fixture.jobId, { home, reason: "" }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CANCELLATION_REASON_INVALID",
  );
  const status = await loadCueLineRunStatus(runId, { home });
  assert.equal(status.cancellation.runRequested, false);
  assert.deepEqual(status.cancellation.jobRequests, []);
});

test("run cancellation imports status-first terminal evidence without overwriting it", async () => {
  const home = await temporaryHome();
  const runId = "run_cancel_status_first_terminal";
  const fixture = await createJobRun(home, runId, "process");
  const terminal = succeededStatus(runId, fixture.jobId, fixture.spec, "VALID_RUN_RESULT");
  await new JobStatusStore(home).write(terminal);

  const result = await cancelCueLineRun(runId, { home });

  assert.equal(result.outcome, "cancelled");
  const persisted = await new JobStatusStore(home).read(fixture.jobId);
  assert.equal(persisted?.status, "succeeded");
  assert.equal(persisted?.result?.stdout, "VALID_RUN_RESULT");
  const reloaded = await RunStore.load({
    home,
    runId,
    initialState: initialRunState(runId, "", "process"),
    reducer: reduceRunState,
  });
  assert.equal(reloaded.state.jobs[fixture.jobId]?.status, "succeeded");
  assert.equal(reloaded.state.jobs[fixture.jobId]?.output, "VALID_RUN_RESULT");
});

test("job cancellation imports status-first terminal evidence without overwriting it", async () => {
  const home = await temporaryHome();
  const runId = "run_job_cancel_status_first_terminal";
  const fixture = await createJobRun(home, runId, "process");
  const terminal = succeededStatus(runId, fixture.jobId, fixture.spec, "VALID_JOB_RESULT");
  await new JobStatusStore(home).write(terminal);

  const result = await cancelCueLineJob(runId, fixture.jobId, { home });

  assert.equal(result.outcome, "already_terminal");
  const persisted = await new JobStatusStore(home).read(fixture.jobId);
  assert.equal(persisted?.status, "succeeded");
  assert.equal(persisted?.result?.stdout, "VALID_JOB_RESULT");
  const reloaded = await RunStore.load({
    home,
    runId,
    initialState: initialRunState(runId, "", "process"),
    reducer: reduceRunState,
  });
  assert.equal(reloaded.state.jobs[fixture.jobId]?.status, "succeeded");
  assert.equal(reloaded.state.jobs[fixture.jobId]?.output, "VALID_JOB_RESULT");
});

test("a crash after response receipt reconciles that response instead of sending a new round", async () => {
  const home = await temporaryHome();
  const runId = "run_response_received_before_acceptance_crash";
  const requestId = "msg_response_received_before_acceptance_crash";
  const conversationUrl = "https://chatgpt.com/c/response-before-acceptance";
  const responseText = `<CueLineControl>${JSON.stringify({
    protocol: "cueline/0.1",
    run_id: runId,
    round: 1,
    request_id: requestId,
    action: "complete",
    final_delivery_text: "RECOVERED_EXISTING_RESPONSE",
  })}</CueLineControl>`;
  const store = await RunStore.create({
    home,
    runId,
    initialState: initialRunState(runId, "", "caller"),
    reducer: reduceRunState,
  });
  await store.append("run_created", { request: "Do not resend received response", executor: "caller" });
  await store.append("controller_turn_requested", {
    round: 1,
    request_id: requestId,
    prompt: "original controller prompt",
    prompt_hash: "original-controller-prompt-hash",
  });
  await store.append("controller_turn_submitted", {
    round: 1,
    request_id: requestId,
    submission_state: "submitted",
    conversation_url: conversationUrl,
    selected_model_label: "Pro",
    composer_prompt_state: "inline_ready",
    baseline_assistant_message_count: 0,
  });
  await store.append("controller_response_received", {
    round: 1,
    request_id: requestId,
    text: responseText,
    conversation_url: conversationUrl,
    selected_model_label: "Pro",
    response_model_slug: "gpt-5-6-pro",
    model_evidence_source: "composer_and_response",
  });
  await store.append("run_failed", {
    code: "INJECTED_AFTER_RESPONSE_RECEIPT",
    message: "runtime stopped before command acceptance",
    stage: "controller_response",
  });
  await store.snapshot();
  assert.equal(store.state.pendingControllerTurns[0]?.requestId, requestId);

  let sendCalls = 0;
  let recoverCalls = 0;
  const browser = {
    async sendTurn(): Promise<ControllerTurn> {
      sendCalls += 1;
      throw new Error("must recover the received response instead of sending");
    },
    async recoverTurn(): Promise<ControllerTurn> {
      recoverCalls += 1;
      return {
        text: responseText,
        conversationUrl,
        model: {
          provider: "chatgpt" as const,
          selectedLabel: "Pro",
          responseModelSlug: "gpt-5-6-pro",
          source: "composer_and_response" as const,
        },
      };
    },
  };
  const result = await continueCueLineRun({
    runId,
    home,
    browser,
    conversationUrl,
    routingConfig,
  });

  assert.equal(result.status, "complete");
  assert.equal(result.finalDeliveryText, "RECOVERED_EXISTING_RESPONSE");
  assert.equal(sendCalls, 0);
  assert.equal(recoverCalls, 1);
  const events = await readEvents(runPaths(home, runId).events);
  assert.equal(events.filter((event) => event.type === "controller_command_accepted").length, 1);
  assert.equal(events.filter((event) => event.type === "controller_turn_requested").length, 1);
});

test("reboot recovery accepts one submitted attachment response without resending or duplicating work", async () => {
  const home = await temporaryHome();
  const runId = "run_rebooted_submitted_attachment";
  const requestId = "msg_rebooted_submitted_attachment";
  const conversationUrl = "https://chatgpt.com/c/rebooted-submitted-attachment";
  const prompt = "attachment-backed controller prompt";
  const responseText = `<CueLineControl>${JSON.stringify({
    protocol: "cueline/0.1",
    run_id: runId,
    round: 35,
    request_id: requestId,
    action: "complete",
    final_delivery_text: "REBOOTED_ATTACHMENT_RECOVERED",
  })}</CueLineControl>`;
  const store = await RunStore.create({
    home,
    runId,
    initialState: initialRunState(runId, prompt, "caller", 40),
    reducer: reduceRunState,
  });
  await store.append("run_created", {
    request: prompt,
    executor: "caller",
    max_rounds: 40,
  });
  await store.append("controller_turn_requested", {
    round: 35,
    request_id: requestId,
    prompt,
    prompt_hash: commandHash(prompt),
    submission_checkpoint_contract: "write_ahead_v1",
  });
  await store.append("controller_turn_submitted", {
    round: 35,
    request_id: requestId,
    submission_state: "submitted",
    conversation_url: conversationUrl,
    selected_model_label: "Pro",
    composer_prompt_state: "attachment_ready",
    baseline_user_message_count: 51,
    baseline_assistant_message_count: 4,
  });
  await store.snapshot();
  const initialRequestIds = store.state.pendingControllerTurns.map((turn) => turn.requestId);
  const initialJobCount = Object.keys(store.state.jobs).length;
  let observeCalls = 0;
  let submitCalls = 0;
  const browser: SubmittedObservationBrowser = {
    submissionCheckpointContract: "write_ahead_v1",
    async observeSubmittedTurn(input): Promise<SubmittedTurnObservation> {
      observeCalls += 1;
      assert.equal(input.requestId, requestId);
      assert.equal(input.attachmentPromptExpected, true);
      assert.equal(input.baselineUserMessageCount, 51);
      assert.equal(input.baselineAssistantMessageCount, 4);
      return {
        status: "response",
        turn: {
          text: responseText,
          conversationUrl,
          model: {
            provider: "chatgpt",
            selectedLabel: "Pro",
            responseModelSlug: "gpt-5-6-pro",
            source: "composer_and_response",
          },
        },
      };
    },
    async submitTurn(): Promise<void> {
      submitCalls += 1;
      throw new Error("reboot attachment recovery must not resend");
    },
    async observeTurn(): Promise<undefined> {
      return undefined;
    },
    async sendTurn(): Promise<ControllerTurn> {
      throw new Error("reboot attachment recovery must use submitted-turn observation");
    },
  };

  const result = await continueCueLineRun({
    runId,
    home,
    browser,
    conversationUrl,
    routingConfig,
  });

  assert.equal(result.status, "complete");
  assert.equal(result.finalDeliveryText, "REBOOTED_ATTACHMENT_RECOVERED");
  assert.equal(observeCalls, 1);
  assert.equal(submitCalls, 0);
  assert.equal(Object.keys(result.state.jobs).length, initialJobCount);
  const events = await readEvents(runPaths(home, runId).events);
  const requestEvents = events.filter((event) => event.type === "controller_turn_requested");
  assert.deepEqual(
    requestEvents.map((event) => (event.payload as Record<string, unknown>).request_id),
    initialRequestIds,
  );
  assert.equal(events.filter((event) => event.type === "job_registered").length, 0);
  assert.equal(events.filter((event) => event.type === "controller_response_received").length, 1);
  assert.equal(events.filter((event) => event.type === "controller_command_accepted").length, 1);
});

test("a stale caller observer is fenced and recovers one normally submitted turn without resending", async () => {
  const home = await temporaryHome();
  const runId = "run_stale_caller_observer_recovery";
  const requestId = "msg_stale_caller_observer_recovery";
  const conversationUrl = "https://chatgpt.com/c/stale-caller-observer-recovery";
  const prompt = "Observe the already submitted Pro turn exactly once";
  const store = await RunStore.create({
    home,
    runId,
    initialState: initialRunState(runId, "", "caller"),
    reducer: reduceRunState,
  });
  await store.append("run_created", {
    request: "Recover a hard-reset read-only controller observer",
    executor: "caller",
  });
  await store.append("controller_turn_requested", {
    round: 1,
    request_id: requestId,
    prompt,
    prompt_hash: "stale-caller-observer-prompt-hash",
  });
  await store.append("controller_turn_submitted", {
    round: 1,
    request_id: requestId,
    submission_state: "submitted",
    conversation_url: conversationUrl,
    selected_model_label: "Pro",
    composer_prompt_state: "inline_ready",
    baseline_assistant_message_count: 0,
  });
  await store.snapshot();
  const heartbeatAt = "2026-07-15T00:00:00.000Z";
  await writeFile(
    runPaths(home, runId).runtimeLease,
    `${JSON.stringify({
      protocol: "cueline/runtime-lease/0.1",
      run_id: runId,
      owner_id: "hard-reset-observer-owner",
      pid: String(process.pid),
      state: "active",
      claimed_at: heartbeatAt,
      heartbeat_at: heartbeatAt,
    })}\n`,
    "utf8",
  );
  let sendCalls = 0;
  let recoverCalls = 0;
  const browser = {
    async sendTurn(): Promise<ControllerTurn> {
      sendCalls += 1;
      throw new Error("stale caller observation recovery must never resend");
    },
    async recoverTurn(input: BrowserTurnInput): Promise<ControllerTurn> {
      recoverCalls += 1;
      return {
        ...completeReply(input, "STALE_OBSERVER_RECOVERED"),
        conversationUrl,
      };
    },
  };

  const recoverableStatus = await loadCueLineRunStatus(runId, {
    home,
    now: () => new Date("2026-07-15T00:01:00.000Z"),
  });
  assert.equal(recoverableStatus.phase, "controller_response_pending");
  assert.equal(recoverableStatus.continueAllowed, true);
  assert.equal(recoverableStatus.safeNextAction, "observe");

  const result = await continueCueLineRun({
    runId,
    home,
    now: () => new Date("2026-07-15T00:01:00.000Z"),
    browser,
    conversationUrl,
    routingConfig,
  });

  assert.equal(result.status, "complete");
  assert.equal(result.finalDeliveryText, "STALE_OBSERVER_RECOVERED");
  assert.equal(sendCalls, 0);
  assert.equal(recoverCalls, 1);
  const events = await readEvents(runPaths(home, runId).events);
  assert.equal(
    events.filter((event) => event.type === "runtime_stale_caller_observer_recovered").length,
    1,
  );
});

test("field submitted wedge pauses after fresh not-sent evidence and retries only on a separate continuation", async () => {
  const home = await temporaryHome();
  const runId = `${submittedTurnWedgeFixture.fixtureRunId}_recovery`;
  const { requestId } = await createSubmittedTurnWedge(home, runId);
  const browser = submittedObservationBrowser(definitelyNotSentObservation());

  const result = await continueCueLineRun({
    runId,
    home,
    browser,
    conversationUrl: submittedTurnWedgeFixture.conversationUrl,
    routingConfig,
  });

  assert.equal(result.status, "awaiting_controller");
  assert.equal(browser.submitCalls, 0);
  const firstEvents = await readEvents(runPaths(home, runId).events);
  const retryRequestsBeforeBoundary = firstEvents.filter(
    (event) =>
      event.type === "controller_turn_requested" &&
      (event.payload as Record<string, unknown>).retry_of_request_id ===
        requestId,
  );
  assert.equal(retryRequestsBeforeBoundary.length, 0);
  assert.equal(
    firstEvents.filter(
      (event) =>
          event.type === "controller_turn_not_sent_confirmed" &&
        (event.payload as Record<string, unknown>).request_id ===
          requestId &&
        (event.payload as Record<string, unknown>).submission_state ===
          "definitely_not_sent",
    ).length,
    1,
  );
  const firstState = await loadCueLineRunState(runId, { home });
  assert.equal(firstState.pendingControllerTurns.length, 0);
  assert.equal(
    firstState.notSentRecovery?.abandonedRequestId,
    requestId,
  );

  const retryBrowser = submittedObservationBrowser(
    { status: "pending" },
    { allowRetrySubmit: true },
  );
  const retried = await continueCueLineRun({
    runId,
    home,
    browser: retryBrowser,
    conversationUrl: submittedTurnWedgeFixture.conversationUrl,
    routingConfig,
  });
  assert.equal(retried.status, "awaiting_controller");
  assert.equal(retryBrowser.submitCalls, 1);
  const retriedEvents = await readEvents(runPaths(home, runId).events);
  const retryRequests = retriedEvents.filter(
    (event) =>
      event.type === "controller_turn_requested" &&
      (event.payload as Record<string, unknown>).retry_of_request_id ===
        requestId,
  );
  assert.equal(retryRequests.length, 1);

  let submittedRecoveryCalls = 0;
  const duplicateBrowser: SubmittedObservationBrowser = {
    async observeSubmittedTurn(): Promise<SubmittedTurnObservation> {
      submittedRecoveryCalls += 1;
      throw new Error("the authorized retry cannot be reclassified for another retry");
    },
    async observeTurn(): Promise<undefined> {
      return undefined;
    },
    async submitTurn(): Promise<void> {
      throw new Error("duplicate continuation must not submit a second pending turn");
    },
    async sendTurn(): Promise<ControllerTurn> {
      throw new Error("duplicate continuation must not send a second pending turn");
    },
  };
  const repeated = await continueCueLineRun({
    runId,
    home,
    browser: duplicateBrowser,
    conversationUrl: submittedTurnWedgeFixture.conversationUrl,
    routingConfig,
  });
  assert.equal(repeated.status, "awaiting_controller");
  assert.equal(submittedRecoveryCalls, 0);
  const repeatedEvents = await readEvents(runPaths(home, runId).events);
  assert.equal(
    repeatedEvents.filter(
      (event) =>
        event.type === "controller_turn_requested" &&
        (event.payload as Record<string, unknown>).retry_of_request_id ===
          requestId,
    ).length,
    1,
  );
  assert.equal((await loadCueLineRunState(runId, { home })).pendingControllerTurns.length, 1);
});

test("field submitted wedge accepts hydration count uplift as not sent without response parsing or repair", async () => {
  const home = await temporaryHome();
  const runId = `${submittedTurnWedgeFixture.fixtureRunId}_hydration_uplift`;
  const { requestId } = await createSubmittedTurnWedge(home, runId);
  const browser = submittedObservationBrowser(
    definitelyNotSentObservation({ observedUserMessageCount: 103 }),
  );

  const result = await continueCueLineRun({
    runId,
    home,
    browser,
    conversationUrl: submittedTurnWedgeFixture.conversationUrl,
    routingConfig,
  });

  assert.equal(result.status, "awaiting_controller");
  assert.equal(browser.submitCalls, 0);
  const state = await loadCueLineRunState(runId, { home });
  assert.equal(state.pendingControllerTurns.length, 0);
  assert.equal(state.notSentRecovery?.abandonedRequestId, requestId);
  const events = await readEvents(runPaths(home, runId).events);
  assert.equal(events.filter((event) => event.type === "controller_response_received").length, 0);
  assert.equal(events.filter((event) => event.type === "controller_response_rejected").length, 0);
  assert.equal(events.filter((event) => event.type === "controller_repair_requested").length, 0);
  assert.equal(
    events.filter(
      (event) =>
        event.type === "controller_turn_requested" &&
        (event.payload as Record<string, unknown>).retry_of_request_id === requestId,
    ).length,
    0,
  );
});

test("submitted not-sent recovery refuses incomplete or conflicting page evidence", async () => {
  const cases: Array<{ name: string; observation: SubmittedTurnObservation }> = [
    {
      name: "count-unknown",
      observation: definitelyNotSentObservation({ observedUserMessageCount: null }),
    },
    {
      name: "unhydrated-zero-count",
      observation: definitelyNotSentObservation({
        hydrated: false,
        observedUserMessageCount: 0,
      }),
    },
    {
      name: "pro-answering",
      observation: definitelyNotSentObservation({ isAnswering: true }),
    },
    {
      name: "request-message-found",
      observation: definitelyNotSentObservation({ requestMessageFound: true }),
    },
  ];

  for (const fixture of cases) {
    const home = await temporaryHome();
    const runId = `${submittedTurnWedgeFixture.fixtureRunId}_${fixture.name}`;
    const { requestId } = await createSubmittedTurnWedge(home, runId);
    const browser = submittedObservationBrowser(fixture.observation);

    const result = await continueCueLineRun({
      runId,
      home,
      browser,
      conversationUrl: submittedTurnWedgeFixture.conversationUrl,
      routingConfig,
    });

    assert.equal(result.status, "awaiting_controller", fixture.name);
    assert.equal(browser.submitCalls, 0, fixture.name);
    const state = await loadCueLineRunState(runId, { home });
    assert.equal(state.pendingControllerTurns.length, 1, fixture.name);
    assert.equal(
      state.pendingControllerTurns[0]?.requestId,
      requestId,
      fixture.name,
    );
    const events = await readEvents(runPaths(home, runId).events);
    assert.equal(
      events.some(
        (event) =>
          event.type === "controller_turn_requested" &&
          (event.payload as Record<string, unknown>).retry_of_request_id ===
            requestId,
      ),
      false,
      fixture.name,
    );
  }
});

test("recovered inspect response reaches a ready boundary before any next controller submission", async () => {
  const home = await temporaryHome();
  const runId = "run_recovered_inspect_ready_boundary";
  const requestId = "msg_recovered_inspect_ready_boundary";
  const conversationUrl = "https://chatgpt.com/c/recovered-inspect-ready-boundary";
  const prompt = "Recover the existing inspect response without sending another round";
  const spec: ControllerJobSpec = {
    job_key: "existing_terminal_job",
    lane: "default",
    mode: "advise",
    task: "Already completed evidence",
  };
  const existingJobId = jobId(runId, spec.job_key, spec);
  const store = await RunStore.create({
    home,
    runId,
    initialState: initialRunState(runId, prompt, "caller", 100),
    reducer: reduceRunState,
  });
  await store.append("run_created", {
    request: prompt,
    executor: "caller",
    max_rounds: 100,
  });
  await store.append("job_registered", {
    job: {
      jobId: existingJobId,
      jobKey: spec.job_key,
      required: true,
      spec,
      status: "succeeded",
      output: "existing evidence",
      error: null,
    },
  });
  await store.append("controller_turn_requested", {
    round: 87,
    request_id: requestId,
    prompt,
    prompt_hash: commandHash(prompt),
    submission_checkpoint_contract: "write_ahead_v1",
  });
  await store.append("controller_turn_submitted", {
    round: 87,
    request_id: requestId,
    submission_state: "submitted",
    conversation_url: conversationUrl,
    selected_model_label: "Pro",
    composer_prompt_state: "attachment_ready",
    baseline_user_message_count: 103,
    baseline_assistant_message_count: 102,
  });
  await store.snapshot();

  const responseText = `<CueLineControl>${JSON.stringify({
    protocol: "cueline/0.1",
    run_id: runId,
    round: 87,
    request_id: requestId,
    action: "inspect",
    job_ids: [existingJobId],
  })}</CueLineControl>`;
  let observeCalls = 0;
  let submitCalls = 0;
  let sendCalls = 0;
  const browser: SubmittedObservationBrowser = {
    submissionCheckpointContract: "write_ahead_v1",
    async observeSubmittedTurn(): Promise<SubmittedTurnObservation> {
      observeCalls += 1;
      return {
        status: "response",
        turn: {
          text: responseText,
          conversationUrl,
          model: {
            provider: "chatgpt",
            selectedLabel: "Pro",
            responseModelSlug: "gpt-5-6-pro",
            source: "composer_and_response",
          },
        },
      };
    },
    async observeTurn(): Promise<undefined> {
      return undefined;
    },
    async submitTurn(): Promise<void> {
      submitCalls += 1;
      throw new Error("recovery boundary must not submit round 88");
    },
    async sendTurn(): Promise<ControllerTurn> {
      sendCalls += 1;
      throw new Error("recovery boundary must not send round 88");
    },
  };

  const result = await continueCueLineRun({
    runId,
    home,
    browser,
    conversationUrl,
    routingConfig,
  });

  assert.equal(result.status, "ready");
  assert.equal(observeCalls, 1);
  assert.equal(submitCalls, 0);
  assert.equal(sendCalls, 0);
  const events = await readEvents(runPaths(home, runId).events);
  assert.equal(events.filter((event) => event.type === "controller_response_received").length, 1);
  assert.equal(events.filter((event) => event.type === "controller_command_accepted").length, 1);
  assert.equal(
    events.filter((event) => event.type === "controller_command_execution_completed").length,
    1,
  );
  assert.equal(events.filter((event) => event.type === "controller_response_rejected").length, 0);
  assert.equal(events.filter((event) => event.type === "controller_repair_requested").length, 0);
  assert.equal(events.filter((event) => event.type === "controller_turn_requested").length, 1);
});

test("recovered round 94 dispatch waits for a separate continuation before registering work", async () => {
  const home = await temporaryHome();
  const runId = "run_round_94_dispatch_boundary";
  const requestId = "msg_round_94_dispatch_boundary";
  const conversationUrl = "https://chatgpt.com/c/round-94-dispatch-boundary";
  const prompt = "Recover round 94 without submitting round 95";
  const spec: ControllerJobSpec = {
    job_key: "round_94_recovered_job",
    lane: "default",
    mode: "advise",
    task: "Execute only on the next independent continuation",
  };
  const store = await RunStore.create({
    home,
    runId,
    initialState: initialRunState(runId, prompt, "caller", 100),
    reducer: reduceRunState,
  });
  await store.append("run_created", {
    request: prompt,
    executor: "caller",
    max_rounds: 100,
  });
  await store.append("controller_turn_requested", {
    round: 94,
    request_id: requestId,
    prompt,
    prompt_hash: commandHash(prompt),
    submission_checkpoint_contract: "write_ahead_v1",
  });
  await store.append("controller_turn_submitted", {
    round: 94,
    request_id: requestId,
    submission_state: "submitted",
    conversation_url: conversationUrl,
    selected_model_label: "Pro",
    composer_prompt_state: "inline_ready",
    baseline_user_message_count: 111,
    baseline_assistant_message_count: 94,
  });
  await store.snapshot();

  const responseText = `<CueLineControl>${JSON.stringify({
    protocol: "cueline/0.1",
    run_id: runId,
    round: 94,
    request_id: requestId,
    action: "dispatch",
    jobs: [spec],
  })}</CueLineControl>`;
  let observeCalls = 0;
  let submitCalls = 0;
  let sendCalls = 0;
  const browser: SubmittedObservationBrowser = {
    submissionCheckpointContract: "write_ahead_v1",
    async observeSubmittedTurn(): Promise<SubmittedTurnObservation> {
      observeCalls += 1;
      return {
        status: "response",
        responseSource: "count_degraded_message_dom_exact_envelope",
        turn: {
          text: responseText,
          conversationUrl,
          model: {
            provider: "chatgpt",
            selectedLabel: "Pro",
            responseModelSlug: "gpt-5-6-pro",
            source: "composer_and_response",
          },
        },
      };
    },
    async observeTurn(): Promise<undefined> {
      return undefined;
    },
    async submitTurn(): Promise<void> {
      submitCalls += 1;
      throw new Error("round 94 recovery must not submit round 95");
    },
    async sendTurn(): Promise<ControllerTurn> {
      sendCalls += 1;
      throw new Error("round 94 recovery must not send round 95");
    },
  };

  const recovered = await continueCueLineRun({
    runId,
    home,
    browser,
    conversationUrl,
    routingConfig,
  });

  assert.equal(recovered.status, "ready");
  assert.equal(observeCalls, 1);
  assert.equal(submitCalls, 0);
  assert.equal(sendCalls, 0);
  const recoveredStatus = await loadCueLineRunStatus(runId, { home });
  assert.equal(recoveredStatus.round, 94);
  const recoveredState = await loadCueLineRunState(runId, { home });
  assert.notEqual(recoveredState.pendingCommandExecution, null);
  let events = await readEvents(runPaths(home, runId).events);
  assert.equal(events.filter((event) => event.type === "job_registered").length, 0);
  assert.equal(events.filter((event) => event.type === "controller_turn_requested").length, 1);

  const dispatched = await continueCueLineRun({
    runId,
    home,
    browser,
    conversationUrl,
    routingConfig,
  });

  assert.equal(dispatched.status, "awaiting_caller");
  assert.equal(observeCalls, 1);
  assert.equal(submitCalls, 0);
  assert.equal(sendCalls, 0);
  events = await readEvents(runPaths(home, runId).events);
  assert.equal(events.filter((event) => event.type === "job_registered").length, 1);
  assert.equal(events.filter((event) => event.type === "controller_turn_requested").length, 1);
});

test("stable pending observation persists diagnostics and surfaces them in run status", async () => {
  const home = await temporaryHome();
  const runId = "run_stable_pending_diagnostic";
  const requestId = "msg_stable_pending_diagnostic";
  const conversationUrl = "https://chatgpt.com/c/stable-pending-diagnostic";
  const prompt = "Observe a stable virtualized pending turn";
  const store = await RunStore.create({
    home,
    runId,
    initialState: initialRunState(runId, prompt, "caller", 100),
    reducer: reduceRunState,
  });
  await store.append("run_created", { request: prompt, executor: "caller", max_rounds: 100 });
  await store.append("controller_turn_requested", {
    round: 95,
    request_id: requestId,
    prompt,
    prompt_hash: commandHash(prompt),
    submission_checkpoint_contract: "write_ahead_v1",
  });
  await store.append("controller_turn_submitted", {
    round: 95,
    request_id: requestId,
    submission_state: "submitted",
    conversation_url: conversationUrl,
    selected_model_label: "Pro",
    composer_prompt_state: "inline_ready",
    baseline_user_message_count: 10,
    baseline_assistant_message_count: 10,
  });
  await store.snapshot();

  const diagnostic = {
    code: "CONTROLLER_OBSERVATION_PENDING_STABLE" as const,
    failedCondition: "observed 9 < baseline 10",
    stableForMs: 600_000,
    thresholdMs: 600_000,
    observedUserMessageCount: 9,
    baselineUserMessageCount: 10,
    requestMessageFound: false,
    requestMessageFoundBy: null,
    assistantTextFoundBy: "last_message" as const,
    composerPromptState: "empty" as const,
    sourcesConsulted: ["message_dom"],
  };
  const browser: SubmittedObservationBrowser = {
    submissionCheckpointContract: "write_ahead_v1",
    async observeSubmittedTurn() {
      return {
        status: "pending",
        evidence: {
          conversationUrl,
          selectedModelLabel: "Pro",
          hydrated: true,
          baselineUserMessageCount: 10,
          observationBaselineUserMessageCount: 9,
          observedUserMessageCount: 9,
          countRegressionDetected: true,
          requestMessageFound: false,
          requestMessageScanComplete: true,
          accessibilityRequestIdFound: null,
          isAnswering: false,
          composerPromptState: "empty",
          composerAttachmentCount: 0,
          composerSendButtonEnabled: false,
          pendingDiagnostic: diagnostic,
        },
      };
    },
    async submitTurn() {
      throw new Error("stable pending diagnostics must never resend");
    },
    async observeTurn() {
      return undefined;
    },
    async sendTurn() {
      throw new Error("stable pending diagnostics must stay read-only");
    },
  };

  const result = await continueCueLineRun({
    runId,
    home,
    browser,
    conversationUrl,
    routingConfig,
  });

  assert.equal(result.status, "awaiting_controller");
  const events = await readEvents(runPaths(home, runId).events);
  const notices = events.filter((event) => event.type === "notice");
  assert.equal(notices.length, 2);
  assert.equal(
    notices.some((event) =>
      String((event.payload as Record<string, unknown>).message).includes(
        "CONTROLLER_OBSERVATION_COUNT_REGRESSION",
      ),
    ),
    true,
  );
  assert.equal(
    notices.some((event) =>
      String((event.payload as Record<string, unknown>).message).includes(
        "CONTROLLER_OBSERVATION_PENDING_STABLE",
      ),
    ),
    true,
  );
  const state = await loadCueLineRunState(runId, { home });
  assert.equal(state.pendingObservationDiagnostic?.failedCondition, diagnostic.failedCondition);
  const status = await loadCueLineRunStatus(runId, { home });
  assert.equal(status.controller.pendingDiagnostic?.code, diagnostic.code);
  assert.equal(status.controller.pendingDiagnostic?.failedCondition, diagnostic.failedCondition);
});

test("submitted exact-envelope recovery preserves the round 94 dispatch boundary", async () => {
  const home = await temporaryHome();
  const runId = "run_round_94_possibly_sent_dispatch_boundary";
  const requestId = "msg_round_94_possibly_sent_dispatch_boundary";
  const conversationUrl = "https://chatgpt.com/c/round-94-possibly-sent-boundary";
  const prompt = "Recover failed round 94 without dispatching in the same continuation";
  const spec: ControllerJobSpec = {
    job_key: "round_94_possibly_sent_recovered_job",
    lane: "default",
    mode: "advise",
    task: "Execute only on the next independent continuation",
  };
  const store = await RunStore.create({
    home,
    runId,
    initialState: initialRunState(runId, prompt, "caller", 100),
    reducer: reduceRunState,
  });
  await store.append("run_created", {
    request: prompt,
    executor: "caller",
    max_rounds: 100,
  });
  await store.append("controller_turn_requested", {
    round: 94,
    request_id: requestId,
    prompt,
    prompt_hash: commandHash(prompt),
    submission_checkpoint_contract: "write_ahead_v1",
  });
  await store.append("controller_turn_submitted", {
    round: 94,
    request_id: requestId,
    submission_state: "submitted",
    conversation_url: conversationUrl,
    selected_model_label: "Pro",
    composer_prompt_state: "inline_ready",
    baseline_user_message_count: 111,
    baseline_assistant_message_count: 94,
  });
  await store.append("run_failed", {
    code: "CONTROLLER_RECONCILIATION_MISMATCH",
    message: "Virtualized last user text was stale before exact-envelope recovery.",
    stage: "reconciling",
    request_id: requestId,
    submission_state: "possibly_sent",
  });
  await store.snapshot();
  assert.equal(store.state.pendingControllerTurns[0]?.submissionState, "submitted");
  assert.equal(store.state.lastFailure?.submissionState, "possibly_sent");
  assert.equal(store.state.lastFailure?.code, "CONTROLLER_RECONCILIATION_MISMATCH");

  const responseText = `<CueLineControl>${JSON.stringify({
    protocol: "cueline/0.1",
    run_id: runId,
    round: 94,
    request_id: requestId,
    action: "dispatch",
    jobs: [spec],
  })}</CueLineControl>`;
  let observeCalls = 0;
  let submitCalls = 0;
  let sendCalls = 0;
  const browser: BrowserAdapter = {
    submissionCheckpointContract: "write_ahead_v1",
    async observeTurn(): Promise<ControllerTurn | undefined> {
      observeCalls += 1;
      return {
        text: responseText,
        conversationUrl,
        model: {
          provider: "chatgpt",
          selectedLabel: "Pro",
          responseModelSlug: "gpt-5-6-pro",
          source: "composer_and_response",
        },
        responseSource: "count_degraded_accessibility_exact_envelope",
      } as ControllerTurn;
    },
    async submitTurn(): Promise<void> {
      submitCalls += 1;
      throw new Error("possibly-sent recovery must not submit round 95");
    },
    async sendTurn(): Promise<ControllerTurn> {
      sendCalls += 1;
      throw new Error("possibly-sent recovery must not send round 95");
    },
  };

  const recovered = await continueCueLineRun({
    runId,
    home,
    browser,
    conversationUrl,
    routingConfig,
  });

  assert.equal(recovered.status, "ready");
  assert.equal(observeCalls, 1);
  assert.equal(submitCalls, 0);
  assert.equal(sendCalls, 0);
  const recoveredStatus = await loadCueLineRunStatus(runId, { home });
  assert.equal(recoveredStatus.round, 94);
  const recoveredState = await loadCueLineRunState(runId, { home });
  assert.notEqual(recoveredState.pendingCommandExecution, null);
  const events = await readEvents(runPaths(home, runId).events);
  assert.equal(events.filter((event) => event.type === "job_registered").length, 0);
  assert.equal(events.filter((event) => event.type === "controller_turn_requested").length, 1);
});

test("correlated recovered response with a malformed envelope requests exactly one repair", async () => {
  const home = await temporaryHome();
  const runId = "run_correlated_recovered_response_repair";
  const requestId = "msg_correlated_recovered_response_repair";
  const conversationUrl = "https://chatgpt.com/c/correlated-recovered-response-repair";
  const prompt = "Recover this current response and repair its malformed envelope once";
  const store = await RunStore.create({
    home,
    runId,
    initialState: initialRunState(runId, prompt, "caller", 100),
    reducer: reduceRunState,
  });
  await store.append("run_created", {
    request: prompt,
    executor: "caller",
    max_rounds: 100,
  });
  await store.append("controller_turn_requested", {
    round: 87,
    request_id: requestId,
    prompt,
    prompt_hash: commandHash(prompt),
    submission_checkpoint_contract: "write_ahead_v1",
  });
  await store.append("controller_turn_submitted", {
    round: 87,
    request_id: requestId,
    submission_state: "submitted",
    conversation_url: conversationUrl,
    selected_model_label: "Pro",
    composer_prompt_state: "attachment_ready",
    baseline_user_message_count: 103,
    baseline_assistant_message_count: 102,
  });
  await store.snapshot();

  const malformedResponse = `<CueLineControl>${JSON.stringify({
    protocol: "cueline/0.1",
    run_id: runId,
    round: 87,
    action: "inspect",
    job_ids: ["job_missing_request_id"],
  })}</CueLineControl>`;
  let observeCalls = 0;
  let submitCalls = 0;
  let sendCalls = 0;
  const browser: SubmittedObservationBrowser = {
    submissionCheckpointContract: "write_ahead_v1",
    async observeSubmittedTurn(): Promise<SubmittedTurnObservation> {
      observeCalls += 1;
      return {
        status: "response",
        turn: {
          text: malformedResponse,
          conversationUrl,
          model: {
            provider: "chatgpt",
            selectedLabel: "Pro",
            responseModelSlug: "gpt-5-6-pro",
            source: "composer_and_response",
          },
        },
      };
    },
    async observeTurn(): Promise<undefined> {
      return undefined;
    },
    async submitTurn(input, hooks): Promise<void> {
      submitCalls += 1;
      assert.equal(input.round, 87);
      assert.equal(input.requestId, requestId);
      assert.equal(input.repairAttempt, 1);
      assert.match(input.prompt, /CONTROL_/);
      await hooks?.onCheckpoint?.({
        submissionState: "submitting",
        composerPromptState: "inline_ready",
        conversationUrl,
        selectedModelLabel: "Pro",
        baselineUserMessageCount: 103,
        baselineAssistantMessageCount: 102,
        clickAttemptState: "attempting",
      });
      await hooks?.onCheckpoint?.({
        submissionState: "submitted",
        composerPromptState: "inline_ready",
        conversationUrl,
        selectedModelLabel: "Pro",
        baselineUserMessageCount: 103,
        baselineAssistantMessageCount: 102,
        clickAttemptState: "accepted",
      });
    },
    async sendTurn(): Promise<ControllerTurn> {
      sendCalls += 1;
      throw new Error("correlated recovery must use split repair submission");
    },
  };

  const result = await continueCueLineRun({
    runId,
    home,
    browser,
    conversationUrl,
    routingConfig,
  });

  assert.equal(result.status, "awaiting_controller");
  assert.equal(observeCalls, 1);
  assert.equal(submitCalls, 1);
  assert.equal(sendCalls, 0);
  const events = await readEvents(runPaths(home, runId).events);
  assert.equal(events.filter((event) => event.type === "controller_response_received").length, 1);
  assert.equal(events.filter((event) => event.type === "controller_response_rejected").length, 1);
  assert.equal(events.filter((event) => event.type === "controller_repair_requested").length, 1);
  assert.equal(events.filter((event) => event.type === "controller_turn_submitted").length, 2);
});

test("confirmControllerTurnNotSent accepts the evidence-gated submitted wedge shape", async () => {
  const home = await temporaryHome();
  const runId = `${submittedTurnWedgeFixture.fixtureRunId}_confirmation`;
  const { requestId } = await createSubmittedTurnWedge(home, runId);
  const browser = submittedObservationBrowser(definitelyNotSentObservation());

  const confirmation = await confirmControllerTurnNotSent(runId, {
    home,
    requestId,
    conversationUrl: submittedTurnWedgeFixture.conversationUrl,
    browser,
  } as Parameters<typeof confirmControllerTurnNotSent>[1] & {
    browser: SubmittedObservationBrowser;
  });

  assert.equal(confirmation.outcome, "confirmed");
  const state = await loadCueLineRunState(runId, { home });
  assert.equal(state.pendingControllerTurns.length, 0);
  assert.equal(
    state.notSentRecovery?.abandonedRequestId,
    requestId,
  );
  assert.equal(state.notSentRecovery?.retryRequestId, null);
});

test("live events 2459-2478 authorize one new recovery after the prior one-shot was consumed", async () => {
  const home = await temporaryHome();
  const fixture = await createRound134LiveNoopWedge(home);
  let observeCalls = 0;
  const browser: SubmittedObservationBrowser = {
    submissionCheckpointContract: "write_ahead_v1",
    async observeSubmittedTurn(input): Promise<SubmittedTurnObservation> {
      observeCalls += 1;
      assert.equal(input.requestId, fixture.requestId);
      assert.equal(
        (input as BrowserTurnInput & { emptyComposerNotSentRecovery?: boolean })
          .emptyComposerNotSentRecovery,
        true,
      );
      return {
        status: "definitely_not_sent",
        evidence: {
          conversationUrl: fixture.conversationUrl,
          selectedModelLabel: "Pro",
          hydrated: true,
          baselineUserMessageCount: 0,
          observationBaselineUserMessageCount: 153,
          observedUserMessageCount: 153,
          countRegressionDetected: false,
          requestMessageFound: false,
          requestMessageScanComplete: true,
          accessibilityRequestIdFound: false,
          isAnswering: false,
          composerPromptState: "empty",
          composerAttachmentCount: 0,
          composerPastedTextAttachmentPresent: false,
          composerSendButtonEnabled: false,
        },
      };
    },
    async submitTurn(): Promise<void> { throw new Error("reauthorization must stay read-only"); },
    async observeTurn(): Promise<undefined> { return undefined; },
    async sendTurn(): Promise<ControllerTurn> {
      throw new Error("split submission must be used");
    },
  };
  const authorization = await reauthorizeControllerPostFixRetry(fixture.runId, {
    home,
    browser,
    requestId: fixture.requestId,
    round: 134,
    conversationUrl: fixture.conversationUrl,
  });
  assert.equal(authorization.outcome, "reauthorized");
  assert.equal(observeCalls, 1);
  let events = await readEvents(runPaths(home, fixture.runId).events);
  assert.equal(events.filter((event) => event.type === "controller_turn_post_fix_retry_reauthorized").length, 2);
  const repeated = await reauthorizeControllerPostFixRetry(fixture.runId, {
    home, browser, requestId: fixture.requestId, round: 134, conversationUrl: fixture.conversationUrl,
  });
  assert.equal(repeated.outcome, "already_reauthorized");
  assert.equal(observeCalls, 1);
  await assert.rejects(
    reauthorizeControllerPostFixRetry(fixture.runId, {
      home,
      browser,
      requestId: fixture.requestId,
      round: 134,
      conversationUrl: "https://chatgpt.com/c/wrong-idempotent-conversation",
    }),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "CONTROLLER_POST_FIX_RETRY_STATE_INVALID",
  );
  assert.equal(observeCalls, 1);

  const store = await loadPersistedRunStore(home, fixture.runId);
  await store.append("controller_turn_requested", {
    round: 134,
    request_id: fixture.requestId,
    prompt: fixture.prompt,
    prompt_hash: commandHash(fixture.prompt),
    retry_of_request_id: fixture.requestId,
    recovery_prompt_hash: commandHash(fixture.prompt),
    post_fix_retry_reauthorized: true,
    submission_checkpoint_contract: "write_ahead_v1",
  });
  await store.snapshot();
  const state = await loadCueLineRunState(fixture.runId, { home });
  assert.equal(state.postFixRetryReauthorization?.status, "consumed");
  events = await readEvents(runPaths(home, fixture.runId).events);
  const postFixRequested = events.filter((event) => event.type === "controller_turn_requested" && (event.payload as Record<string, unknown>).post_fix_retry_reauthorized === true);
  assert.equal(postFixRequested.length, 2);
  assert.equal((postFixRequested[1]!.payload as Record<string, unknown>).request_id, fixture.requestId);

  await assert.rejects(
    reauthorizeControllerPostFixRetry(fixture.runId, { home, browser, requestId: fixture.requestId, round: 134, conversationUrl: fixture.conversationUrl }),
    (error: unknown) => error instanceof CueLineError && error.code === "CONTROLLER_POST_FIX_RETRY_EXHAUSTED",
  );
});

test("round 134 replay accepts an exact Pro response after submitted proof despite stale not-sent recovery", async () => {
  const home = await temporaryHome();
  const fixture = await createRound134LiveNoopWedge(home);
  const promptHash = commandHash(fixture.prompt);
  const evidenceSpec: ControllerJobSpec = {
    job_key: "round_134_existing_evidence",
    lane: "default",
    mode: "advise",
    task: "Inspect evidence already completed before round 134",
  };
  const evidenceJobId = jobId(fixture.runId, evidenceSpec.job_key, evidenceSpec);
  const store = await loadPersistedRunStore(home, fixture.runId);
  await store.append("job_registered", {
    job: {
      jobId: evidenceJobId,
      jobKey: evidenceSpec.job_key,
      required: true,
      spec: evidenceSpec,
      status: "succeeded",
      output: "existing evidence",
      error: null,
    },
  });
  const replayTail = [
    ["controller_turn_post_fix_retry_reauthorized", {
      round: 134,
      request_id: fixture.requestId,
      prompt_hash: promptHash,
      conversation_url: fixture.conversationUrl,
      failure_code: "CONTROLLER_PROMPT_NOT_SENT",
      submission_state: "definitely_not_sent",
      not_sent_recovery_status: "retry_pending",
      composer_prompt_state: "empty",
      composer_attachment_count: 0,
      baseline_user_message_count: 0,
      observed_user_message_count: 0,
      selected_model_label: "Pro",
      confirmation_source: "fresh_read_only_observation",
      one_shot: true,
    }],
    ["controller_turn_abandoned", {
      round: 134,
      request_id: fixture.requestId,
      reason: "post_fix_retry_reauthorized",
      round_not_consumed: true,
    }],
    ["run_resumed", { previous_status: "failed" }],
    ["controller_conversation_bound", { conversation_url: fixture.conversationUrl }],
    ["controller_turn_requested", {
      round: 134,
      request_id: fixture.requestId,
      prompt: fixture.prompt,
      prompt_hash: promptHash,
      retry_of_request_id: fixture.requestId,
      recovery_prompt_hash: promptHash,
      post_fix_retry_reauthorized: true,
      submission_checkpoint_contract: "write_ahead_v1",
    }],
    ["controller_turn_prompt_staged", {
      round: 134,
      request_id: fixture.requestId,
      conversation_url: fixture.conversationUrl,
      selected_model_label: "Pro",
      composer_prompt_state: "attachment_ready",
      baseline_user_message_count: 150,
      baseline_assistant_message_count: 3,
    }],
    ["controller_turn_submission_started", {
      round: 134,
      request_id: fixture.requestId,
      submission_state: "submitting",
      conversation_url: fixture.conversationUrl,
      selected_model_label: "Pro",
      composer_prompt_state: "attachment_ready",
      baseline_user_message_count: 150,
      baseline_assistant_message_count: 3,
    }],
    ["controller_turn_submitted", {
      round: 134,
      request_id: fixture.requestId,
      submission_state: "submitted",
      conversation_url: fixture.conversationUrl,
      selected_model_label: "Pro",
      composer_prompt_state: "attachment_ready",
      baseline_user_message_count: 150,
      baseline_assistant_message_count: 3,
    }],
    ["run_resumed", { previous_status: "running" }],
    ["run_failed", {
      code: "CONTROLLER_NOT_SENT_CONFIRMATION_CONFLICT",
      request_id: fixture.requestId,
      stage: "reconciling",
      submission_state: "possibly_sent",
      conversation_url: fixture.conversationUrl,
    }],
  ] as const;
  for (const [type, payload] of replayTail) await store.append(type, payload);
  await store.snapshot();

  const replayed = await loadCueLineRunState(fixture.runId, { home });
  assert.equal(replayed.status, "failed");
  assert.equal(replayed.pendingControllerTurns[0]?.submissionState, "submitted");
  assert.equal(replayed.notSentRecovery?.status, "conflict");
  const recoverableStatus = await loadCueLineRunStatus(fixture.runId, { home });
  assert.equal(recoverableStatus.phase, "controller_response_pending");
  assert.equal(recoverableStatus.continueAllowed, true);
  assert.equal(recoverableStatus.safeNextAction, "observe");

  const responseText = `<CueLineControl>${JSON.stringify({
    protocol: "cueline/0.1",
    run_id: fixture.runId,
    round: 134,
    request_id: fixture.requestId,
    action: "inspect",
    job_ids: [evidenceJobId],
  })}</CueLineControl>`;
  let observeCalls = 0;
  const browser: BrowserAdapter = {
    submissionCheckpointContract: "write_ahead_v1",
    async observeTurn(input): Promise<ControllerTurn> {
      observeCalls += 1;
      assert.equal(input.requestId, fixture.requestId);
      assert.equal(input.durableSubmittedCheckpoint, true);
      assert.equal(input.notSentRecovery?.baselineUserMessageCount, 0);
      return {
        text: responseText,
        conversationUrl: fixture.conversationUrl,
        model: {
          provider: "chatgpt",
          selectedLabel: "Pro",
          responseModelSlug: "gpt-5-6-pro",
          source: "composer_and_response",
        },
      };
    },
    async submitTurn(): Promise<void> {
      throw new Error("submitted response recovery must not submit round 135");
    },
    async sendTurn(): Promise<ControllerTurn> {
      throw new Error("submitted response recovery must not send round 135");
    },
  };

  const result = await continueCueLineRun({
    runId: fixture.runId,
    home,
    browser,
    conversationUrl: fixture.conversationUrl,
    routingConfig,
  });

  assert.equal(result.status, "ready");
  assert.equal(observeCalls, 1);
  const recovered = await loadCueLineRunState(fixture.runId, { home });
  assert.equal(recovered.pendingControllerTurns.length, 0);
  assert.equal(recovered.notSentRecovery, null);
  const events = await readEvents(runPaths(home, fixture.runId).events);
  assert.equal(events.filter((event) => event.type === "controller_response_received").length, 1);
  assert.equal(events.filter((event) => event.type === "controller_command_accepted").length, 1);
  assert.equal(
    events.filter(
      (event) =>
        event.type === "controller_turn_requested" &&
        (event.payload as Record<string, unknown>).round === 135,
    ).length,
    0,
  );
});

test("confirmControllerTurnMisdirected records read-only evidence and authorizes one retry", async () => {
  const home = await temporaryHome();
  const fixture = await createMisdirectedSubmittedWedge(home, "happy");
  const browser = misdirectedObservationBrowser(
    fixture,
    confirmedMisdirectedObservation(fixture),
  );

  const confirmation = await confirmControllerTurnMisdirected(fixture.runId, {
    home,
    requestId: fixture.requestId,
    misdirectedConversationUrl: fixture.misdirectedConversationUrl,
    browser,
  });

  assert.equal(confirmation.outcome, "confirmed");
  assert.equal(
    confirmation.observedBaselineUserMessageCount,
    fixture.baselineUserMessageCount,
  );
  assert.equal(browser.submitCalls, 0);
  let state = await loadCueLineRunState(fixture.runId, { home });
  assert.equal(state.pendingControllerTurns.length, 0);
  assert.equal(state.notSentRecovery?.abandonedRequestId, fixture.requestId);
  assert.equal(state.notSentRecovery?.conversationUrl, fixture.conversationUrl);
  assert.equal(
    state.notSentRecovery?.baselineUserMessageCount,
    fixture.baselineUserMessageCount,
  );
  const confirmedEvents = await readEvents(runPaths(home, fixture.runId).events);
  assert.equal(
    confirmedEvents.filter((event) => event.type === "controller_turn_misdirected_confirmed")
      .length,
    1,
  );
  assert.equal(
    confirmedEvents.filter((event) => {
      const payload = event.payload as Record<string, unknown>;
      return (
        event.type === "controller_turn_not_sent_confirmed" &&
        payload.request_id === fixture.requestId
      );
    }).length,
    1,
  );

  const retryBrowser = misdirectedObservationBrowser(
    fixture,
    confirmedMisdirectedObservation(fixture),
    { allowRetrySubmit: true },
  );
  const continued = await continueCueLineRun({
    runId: fixture.runId,
    home,
    browser: retryBrowser,
    conversationUrl: fixture.conversationUrl,
  });

  assert.equal(continued.status, "awaiting_controller");
  assert.equal(retryBrowser.submitCalls, 1);
  state = await loadCueLineRunState(fixture.runId, { home });
  assert.equal(state.round, fixture.round);
  assert.equal(state.pendingControllerTurns.length, 1);
  assert.equal(state.pendingControllerTurns[0]?.retryOfRequestId, fixture.requestId);
  assert.notEqual(state.pendingControllerTurns[0]?.requestId, fixture.requestId);
  const retriedEvents = await readEvents(runPaths(home, fixture.runId).events);
  const requested95 = retriedEvents.filter((event) => {
    const payload = event.payload as Record<string, unknown>;
    return event.type === "controller_turn_requested" && payload.round === fixture.round;
  });
  assert.equal(requested95.length, 2);
});

test("confirmControllerTurnMisdirected returns pending without mutation while orphan answer is active", async () => {
  const home = await temporaryHome();
  const fixture = await createMisdirectedSubmittedWedge(home, "pending");
  const before = await readEvents(runPaths(home, fixture.runId).events);
  const browser = misdirectedObservationBrowser(fixture, {
    ...confirmedMisdirectedObservation(fixture),
    status: "pending",
    evidence: {
      ...confirmedMisdirectedObservation(fixture).evidence,
      misdirected: {
        ...confirmedMisdirectedObservation(fixture).evidence.misdirected,
        isAnswering: true,
        exactEnvelopeFound: false,
      },
    },
  });

  const confirmation = await confirmControllerTurnMisdirected(fixture.runId, {
    home,
    requestId: fixture.requestId,
    misdirectedConversationUrl: fixture.misdirectedConversationUrl,
    browser,
  });

  assert.equal(confirmation.outcome, "pending");
  assert.deepEqual(await readEvents(runPaths(home, fixture.runId).events), before);
});

test("confirmControllerTurnMisdirected fails closed on URL and evidence conflicts", async () => {
  const home = await temporaryHome();
  const sameUrlFixture = await createMisdirectedSubmittedWedge(home, "sameurl");
  await assert.rejects(
    confirmControllerTurnMisdirected(sameUrlFixture.runId, {
      home,
      requestId: sameUrlFixture.requestId,
      misdirectedConversationUrl: sameUrlFixture.conversationUrl,
      browser: misdirectedObservationBrowser(
        sameUrlFixture,
        confirmedMisdirectedObservation(sameUrlFixture),
      ),
    }),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "CONTROLLER_RECONCILIATION_CONVERSATION_MISMATCH",
  );

  const weakFixture = await createMisdirectedSubmittedWedge(home, "weakevidence");
  await assert.rejects(
    confirmControllerTurnMisdirected(weakFixture.runId, {
      home,
      requestId: weakFixture.requestId,
      misdirectedConversationUrl: weakFixture.misdirectedConversationUrl,
      browser: misdirectedObservationBrowser(
        weakFixture,
        confirmedMisdirectedObservation(weakFixture, {
          misdirected: {
            pageUrl: weakFixture.misdirectedConversationUrl,
            isAnswering: false,
            assistantMessageCount: weakFixture.round,
            exactEnvelopeFound: false,
          },
        }),
      ),
    }),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "CONTROLLER_NOT_SENT_EVIDENCE_INSUFFICIENT",
  );
});

test("explicit reconciliation confirms a submission-started residual attachment without resending", async () => {
  const home = await temporaryHome();
  const fixture = await createSubmissionStartedAttachmentWedge(home, "residual");
  let observeCalls = 0;
  let submitCalls = 0;
  const browser: SubmittedObservationBrowser = {
    submissionCheckpointContract: "write_ahead_v1",
    async observeSubmittedTurn(input): Promise<SubmittedTurnObservation> {
      observeCalls += 1;
      assert.equal(input.runId, fixture.runId);
      assert.equal(input.round, 85);
      assert.equal(input.requestId, fixture.requestId);
      assert.equal(input.prompt, fixture.prompt);
      assert.equal(input.attachmentPromptExpected, true);
      assert.equal(input.baselineUserMessageCount, fixture.baselineUserMessageCount);
      return {
        status: "definitely_not_sent",
        evidence: {
          conversationUrl: fixture.conversationUrl,
          selectedModelLabel: "Pro",
          hydrated: true,
          baselineUserMessageCount: fixture.baselineUserMessageCount,
          observedUserMessageCount: fixture.baselineUserMessageCount,
          requestMessageFound: false,
          isAnswering: false,
          composerPromptState: "attachment_ready",
          composerAttachmentCount: 1,
          composerSendButtonEnabled: true,
        },
      };
    },
    async submitTurn(): Promise<void> {
      submitCalls += 1;
      throw new Error("not-sent reconciliation must not submit");
    },
    async observeTurn(): Promise<undefined> {
      return undefined;
    },
    async sendTurn(): Promise<ControllerTurn> {
      throw new Error("not-sent reconciliation must stay read-only");
    },
  };

  const confirmation = await confirmControllerTurnNotSent(fixture.runId, {
    home,
    requestId: fixture.requestId,
    conversationUrl: fixture.conversationUrl,
    browser,
  } as Parameters<typeof confirmControllerTurnNotSent>[1] & {
    browser: SubmittedObservationBrowser;
  });

  assert.equal(confirmation.outcome, "confirmed");
  assert.equal(observeCalls, 1);
  assert.equal(submitCalls, 0);
  const state = await loadCueLineRunState(fixture.runId, { home });
  assert.equal(state.round, 84);
  assert.equal(state.pendingControllerTurns.length, 0);
  assert.equal(state.notSentRecovery?.abandonedRequestId, fixture.requestId);
  assert.equal(state.notSentRecovery?.retryRequestId, null);
  const events = await readEvents(runPaths(home, fixture.runId).events);
  assert.equal(events.filter((event) => event.type === "controller_turn_requested").length, 1);
  assert.equal(
    events.filter((event) => event.type === "controller_turn_submission_started").length,
    1,
  );
  assert.equal(events.filter((event) => event.type === "controller_turn_submitted").length, 0);
  assert.equal(
    events.filter((event) => event.type === "controller_turn_not_sent_confirmed").length,
    1,
  );
  assert.equal(events.filter((event) => event.type === "controller_turn_abandoned").length, 1);
});

test("submission-started reconciliation distinguishes a sent message and never marks it not sent", async () => {
  const home = await temporaryHome();
  const fixture = await createSubmissionStartedAttachmentWedge(home, "sent");
  let submitCalls = 0;
  const browser: SubmittedObservationBrowser = {
    submissionCheckpointContract: "write_ahead_v1",
    async observeSubmittedTurn(): Promise<SubmittedTurnObservation> {
      return {
        status: "pending",
        evidence: {
          conversationUrl: fixture.conversationUrl,
          selectedModelLabel: "Pro",
          hydrated: true,
          baselineUserMessageCount: fixture.baselineUserMessageCount,
          observedUserMessageCount: fixture.baselineUserMessageCount + 1,
          requestMessageFound: true,
          isAnswering: true,
          composerPromptState: "empty",
          composerAttachmentCount: 0,
          composerSendButtonEnabled: false,
        },
      };
    },
    async submitTurn(): Promise<void> {
      submitCalls += 1;
      throw new Error("sent-message reconciliation must never resend");
    },
    async observeTurn(): Promise<undefined> {
      return undefined;
    },
    async sendTurn(): Promise<ControllerTurn> {
      throw new Error("sent-message reconciliation must stay read-only");
    },
  };

  await assert.rejects(
    confirmControllerTurnNotSent(fixture.runId, {
      home,
      requestId: fixture.requestId,
      conversationUrl: fixture.conversationUrl,
      browser,
    } as Parameters<typeof confirmControllerTurnNotSent>[1] & {
      browser: SubmittedObservationBrowser;
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CONTROLLER_NOT_SENT_EVIDENCE_INSUFFICIENT",
  );

  assert.equal(submitCalls, 0);
  const state = await loadCueLineRunState(fixture.runId, { home });
  assert.equal(state.round, 85);
  assert.equal(state.pendingControllerTurns[0]?.requestId, fixture.requestId);
  const events = await readEvents(runPaths(home, fixture.runId).events);
  assert.equal(events.filter((event) => event.type === "controller_turn_requested").length, 1);
  assert.equal(
    events.filter((event) => event.type === "controller_turn_not_sent_confirmed").length,
    0,
  );
  assert.equal(events.filter((event) => event.type === "controller_turn_abandoned").length, 0);
});

test("status hides stale reconciliation metadata from an unrelated current round", async () => {
  const home = await temporaryHome();
  const runId = `${submittedTurnWedgeFixture.fixtureRunId}_status`;
  await createSubmittedTurnWedge(home, runId);

  const status = await loadCueLineRunStatus(runId, { home });

  assert.equal(status.round, submittedTurnWedgeFixture.round);
  assert.equal(status.controller.pendingTurns, 1);
  assert.equal(status.controller.reconciliation, undefined);
});

test("stale caller observation recovery refuses every ambiguous or side-effectful variant", () => {
  const conversationUrl = "https://chatgpt.com/c/strict-stale-observer";
  const base = {
    ...initialRunState("run_strict_stale_observer", "Observe only", "caller"),
    round: 1,
    pendingControllerTurns: [
      {
        round: 1,
        requestId: "msg_strict_stale_observer",
        prompt: "Observe only",
        promptHash: "hash",
        repairAttempt: 0,
        submissionState: "submitted" as const,
        conversationUrl,
        selectedModelLabel: "Pro",
        baselineAssistantMessageCount: 0,
        composerPromptState: "inline_ready" as const,
        manualSendConfirmed: false,
        submissionCheckpointContract: "write_ahead_v1" as const,
      },
    ],
    conversationUrl,
  };
  const runtime = {
    ownership: "stale" as const,
    ownerId: "stale-observer-owner",
    heartbeatAt: "2026-07-15T00:00:00.000Z",
  };
  const cancellation = { runRequested: false, jobRequests: [] };
  assert.equal(isSafeStaleCallerObservationRecovery(base, runtime, cancellation), true);

  const variants = [
    {
      ...base,
      pendingControllerTurns: [
        { ...base.pendingControllerTurns[0]!, submissionState: "possibly_sent" as const },
      ],
    },
    {
      ...base,
      pendingControllerTurns: [
        { ...base.pendingControllerTurns[0]!, manualSendConfirmed: true },
      ],
    },
    {
      ...base,
      conversationUrl: null,
      pendingControllerTurns: [
        { ...base.pendingControllerTurns[0]!, conversationUrl: null },
      ],
    },
    {
      ...base,
      conversationUrl: "https://chatgpt.com/c/different-conversation",
    },
    {
      ...base,
      jobs: {
        active: {
          jobId: "active",
          jobKey: "active",
          required: true,
          spec: {
            job_key: "active",
            lane: "default",
            mode: "advise" as const,
            task: "Must keep stale recovery disabled",
          },
          status: "pending" as const,
          output: null,
          error: null,
        },
      },
    },
    {
      ...base,
      pendingCommandExecution: {
        commandHash: "hash",
        command: {
          protocol: "cueline/0.1" as const,
          run_id: base.runId,
          round: 1,
          request_id: "msg_strict_stale_observer",
          action: "inspect" as const,
        },
      },
    },
  ];
  for (const variant of variants) {
    assert.equal(
      isSafeStaleCallerObservationRecovery(variant, runtime, cancellation),
      false,
    );
  }
  assert.equal(
    isSafeStaleCallerObservationRecovery(base, runtime, {
      runRequested: true,
      jobRequests: [],
    }),
    false,
  );
});

test("caller result input is fully validated before any durable write", async () => {
  const home = await temporaryHome();
  const runId = "run_missing_for_invalid_caller_result";
  const jobIdValue = "job_invalid_caller_result";
  const invalidInputs: unknown[] = [
    null,
    { status: "unknown" },
    { status: "succeeded", stdout: 7 },
    { status: "succeeded", stderr: {} },
    { status: "succeeded", output: [] },
    { status: "failed", error: 42 },
    { status: "succeeded", startedAt: 1 },
    { status: "succeeded", finishedAt: false },
    { status: "succeeded", exitCode: 1.5 },
  ];
  for (const input of invalidInputs) {
    await assert.rejects(
      submitCueLineCallerJobResult(
        runId,
        jobIdValue,
        input as Parameters<typeof submitCueLineCallerJobResult>[2],
        { home },
      ),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error.code === "CALLER_JOB_RESULT_INVALID" ||
          error.code === "CALLER_JOB_STATUS_INVALID"),
    );
  }
  assert.equal(await new JobStatusStore(home).read(jobIdValue), undefined);
});

test("continuation reconciles ownerless active process jobs even after the run failed", async () => {
  const home = await temporaryHome();
  const runId = "run_failed_ownerless_active_job";
  const fixture = await createJobRun(home, runId, "process", { failed: true });
  const browser = new FakeBrowserAdapter([
    (input) => {
      assert.match(input.prompt, /worker process disappeared/i);
      return completeReply(input, "FAILED_OWNER_RECONCILED");
    },
  ]);

  const result = await continueCueLineRun({
    runId,
    home,
    browser,
    routingConfig,
    allowProcessExecution: true,
  });

  assert.equal(result.status, "complete");
  assert.equal(result.state.jobs[fixture.jobId]?.status, "failed");
  assert.equal(result.finalDeliveryText, "FAILED_OWNER_RECONCILED");
});

async function writeStaleSubmitterLease(
  home: string,
  runId: string,
  heartbeatAt: string,
): Promise<void> {
  await writeFile(
    runPaths(home, runId).runtimeLease,
    `${JSON.stringify({
      protocol: "cueline/runtime-lease/0.1",
      run_id: runId,
      owner_id: "repl-dead-submitter",
      pid: String(process.pid),
      state: "active",
      claimed_at: heartbeatAt,
      heartbeat_at: heartbeatAt,
    })}\n`,
    "utf8",
  );
}

test("a taken-over stale submission-started turn accepts operator not-sent confirmation without a browser", async () => {
  const home = await temporaryHome();
  const fixture = await createSubmissionStartedAttachmentWedge(home, "staletakeover");
  await writeStaleSubmitterLease(home, fixture.runId, "2026-07-15T00:00:00.000Z");
  const now = () => new Date("2026-07-15T00:01:00.000Z");

  const takeover = await takeoverCueLineRuntime(fixture.runId, { home, now });
  assert.equal(takeover.outcome, "taken_over");

  const status = await loadCueLineRunStatus(fixture.runId, { home, now });
  assert.equal(status.phase, "reconciliation_required");

  const confirmation = await confirmControllerTurnNotSent(fixture.runId, {
    home,
    requestId: fixture.requestId,
    conversationUrl: fixture.conversationUrl,
  });
  assert.equal(confirmation.outcome, "confirmed");

  const state = await loadCueLineRunState(fixture.runId, { home });
  assert.equal(state.pendingControllerTurns.length, 0);
  assert.equal(state.notSentRecovery?.abandonedRequestId, fixture.requestId);
  assert.equal(state.notSentRecovery?.retryRequestId, null);

  const events = await readEvents(runPaths(home, fixture.runId).events);
  const confirmed = events.filter(
    (event) => event.type === "controller_turn_not_sent_confirmed",
  );
  assert.equal(confirmed.length, 1);
  const confirmedPayload = confirmed[0]?.payload as Record<string, unknown>;
  assert.equal(confirmedPayload.request_id, fixture.requestId);
  assert.equal(confirmedPayload.operator_confirmation, true);
  const abandoned = events.filter(
    (event) => event.type === "controller_turn_abandoned",
  );
  assert.equal(abandoned.length, 1);
  assert.equal(
    (abandoned[0]?.payload as Record<string, unknown>).round_not_consumed,
    true,
  );

  const repeated = await confirmControllerTurnNotSent(fixture.runId, {
    home,
    requestId: fixture.requestId,
    conversationUrl: fixture.conversationUrl,
  });
  assert.equal(repeated.outcome, "already_confirmed");

  // The recovery state must carry the staged-attachment shape (replayed from the
  // permanent not_sent_confirmed / abandoned records) so the retry can reuse the
  // composer attachment instead of dying on the attachment-mixing guard. Both the
  // confirmed and abandoned reducer branches must preserve it, and it must survive
  // a fresh load from disk (never a memory-only flag).
  assert.equal(state.notSentRecovery?.composerPromptState, "attachment_ready");
  const stagedEvents = await readEvents(runPaths(home, fixture.runId).events);
  const notSentConfirmed = stagedEvents.find(
    (event) => event.type === "controller_turn_not_sent_confirmed",
  );
  assert.equal(
    (notSentConfirmed?.payload as Record<string, unknown>).composer_prompt_state,
    "attachment_ready",
  );
  const stagedAbandoned = stagedEvents.find(
    (event) => event.type === "controller_turn_abandoned",
  );
  assert.equal(
    (stagedAbandoned?.payload as Record<string, unknown>).composer_prompt_state,
    "attachment_ready",
  );
});

test("a stale submission-started turn without a formal takeover still refuses browserless not-sent confirmation", async () => {
  const home = await temporaryHome();
  const fixture = await createSubmissionStartedAttachmentWedge(home, "notakeover");

  await assert.rejects(
    confirmControllerTurnNotSent(fixture.runId, {
      home,
      requestId: fixture.requestId,
      conversationUrl: fixture.conversationUrl,
    }),
    (error: unknown) =>
      (error as { code?: string }).code === "CONTROLLER_NOT_SENT_STATE_INVALID",
  );
});

test("a taken-over turn with a recorded submitted event refuses browserless not-sent confirmation", async () => {
  const home = await temporaryHome();
  const fixture = await createSubmissionStartedAttachmentWedge(home, "alreadysubmitted");
  const store = await RunStore.load({
    home,
    runId: fixture.runId,
    initialState: initialRunState(fixture.runId, fixture.prompt, "caller", 100),
    reducer: reduceRunState,
  });
  await store.append("controller_turn_submitted", {
    round: 85,
    request_id: fixture.requestId,
    submission_state: "submitted",
    conversation_url: fixture.conversationUrl,
    selected_model_label: "Pro",
    prompt_hash: commandHash(fixture.prompt),
    baseline_user_message_count: fixture.baselineUserMessageCount,
  });
  await store.snapshot();
  await writeStaleSubmitterLease(home, fixture.runId, "2026-07-15T00:00:00.000Z");
  const now = () => new Date("2026-07-15T00:01:00.000Z");
  const takeover = await takeoverCueLineRuntime(fixture.runId, { home, now });
  assert.equal(takeover.outcome, "taken_over");

  await assert.rejects(
    confirmControllerTurnNotSent(fixture.runId, {
      home,
      requestId: fixture.requestId,
      conversationUrl: fixture.conversationUrl,
    }),
    (error: unknown) => {
      const code = (error as { code?: string }).code;
      return (
        code === "CONTROLLER_NOT_SENT_STATE_INVALID" ||
        code === "CONTROLLER_NOT_SENT_EVIDENCE_REQUIRED"
      );
    },
  );
});

async function createRejectedAttachmentIdentityWedge(
  home: string,
  suffix: string,
  options: { recordedConversationUrl?: string; action?: "complete" | "wait" } = {},
): Promise<{
  runId: string;
  originalRequestId: string;
  retryRequestId: string;
  conversationUrl: string;
  responseText: string;
}> {
  const runId = `run_rejected_identity_${suffix}`;
  const originalRequestId = `msg_original_identity_${suffix}`;
  const retryRequestId = `msg_retry_attempt_${suffix}`;
  const conversationUrl = `https://chatgpt.com/c/rejected-identity-${suffix}`;
  const originalPrompt = `Round 85 controller observation ${suffix} request ${originalRequestId}`;
  const retryPrompt = originalPrompt.split(originalRequestId).join(retryRequestId);
  const responseText = `<CueLineControl>${JSON.stringify({
    protocol: "cueline/0.1",
    run_id: runId,
    round: 85,
    request_id: originalRequestId,
    ...(options.action === "wait"
      ? { action: "wait" }
      : {
          action: "complete",
          final_delivery_text: "RECONCILED_ORIGINAL_IDENTITY",
        }),
  })}</CueLineControl>`;
  const store = await RunStore.create({
    home,
    runId,
    initialState: initialRunState(runId, originalPrompt, "caller", 100),
    reducer: reduceRunState,
  });
  await store.append("run_created", {
    request: originalPrompt,
    executor: "caller",
    max_rounds: 100,
  });
  await store.append("controller_turn_requested", {
    round: 85,
    request_id: originalRequestId,
    prompt: originalPrompt,
    prompt_hash: commandHash(originalPrompt),
    submission_checkpoint_contract: "write_ahead_v1",
  });
  await store.append("controller_turn_submission_started", {
    round: 85,
    request_id: originalRequestId,
    submission_state: "submitting",
    conversation_url: conversationUrl,
    selected_model_label: "Pro",
    prompt_hash: commandHash(originalPrompt),
    composer_prompt_state: "attachment_ready",
    baseline_user_message_count: 101,
    baseline_assistant_message_count: 16,
    click_attempt_state: "attempting",
  });
  await store.append("controller_turn_not_sent_confirmed", {
    round: 85,
    request_id: originalRequestId,
    prompt_hash: commandHash(originalPrompt),
    conversation_url: conversationUrl,
    selected_model_label: "Pro",
    baseline_user_message_count: 101,
    composer_prompt_state: "attachment_ready",
    operator_confirmation: true,
  });
  await store.append("controller_turn_abandoned", {
    round: 85,
    request_id: originalRequestId,
    reason: "operator_confirmed_not_sent",
    round_not_consumed: true,
    prompt_hash: commandHash(originalPrompt),
    conversation_url: conversationUrl,
    selected_model_label: "Pro",
    baseline_user_message_count: 101,
    composer_prompt_state: "attachment_ready",
    operator_confirmation: true,
  });
  await store.append("controller_turn_requested", {
    round: 85,
    request_id: retryRequestId,
    prompt: retryPrompt,
    prompt_hash: commandHash(retryPrompt),
    retry_of_request_id: originalRequestId,
    recovery_prompt_hash: commandHash(originalPrompt),
    submission_checkpoint_contract: "write_ahead_v1",
  });
  await store.append("controller_turn_submission_started", {
    round: 85,
    request_id: retryRequestId,
    submission_state: "submitting",
    conversation_url: conversationUrl,
    selected_model_label: "Pro",
    composer_prompt_state: "attachment_ready",
    baseline_user_message_count: 101,
    baseline_assistant_message_count: 16,
    click_attempt_state: "attempting",
  });
  await store.append("controller_turn_submitted", {
    round: 85,
    request_id: retryRequestId,
    submission_state: "submitted",
    conversation_url: conversationUrl,
    selected_model_label: "Pro",
    composer_prompt_state: "attachment_ready",
    baseline_user_message_count: 101,
    baseline_assistant_message_count: 16,
    click_attempt_state: "accepted",
  });
  await store.append("controller_response_received", {
    round: 85,
    request_id: retryRequestId,
    text: responseText,
    conversation_url: options.recordedConversationUrl ?? conversationUrl,
    selected_model_label: "Pro",
    response_model_slug: "gpt-5-6-pro",
    model_evidence_source: "composer_and_response",
  });
  await store.append("controller_response_rejected", {
    code: "CONTROL_ID_MISMATCH",
    message: "Controller command identity does not match the pending request.",
    repair_attempt: 0,
  });
  await store.append("controller_repair_requested", {
    round: 85,
    request_id: retryRequestId,
    prompt: `repair prompt ${suffix}`,
    prompt_hash: commandHash(`repair prompt ${suffix}`),
    repair_attempt: 1,
    submission_checkpoint_contract: "write_ahead_v1",
  });
  await store.snapshot();
  return { runId, originalRequestId, retryRequestId, conversationUrl, responseText };
}

function pageUntouchableBrowser(): BrowserAdapter {
  return {
    submissionCheckpointContract: "write_ahead_v1",
    async sendTurn(): Promise<ControllerTurn> {
      throw new Error("read-only reconciliation must not touch the page");
    },
    async submitTurn(): Promise<void> {
      throw new Error("read-only reconciliation must not touch the page");
    },
    async observeTurn(): Promise<undefined> {
      throw new Error("read-only reconciliation must not touch the page");
    },
  };
}

test("a response rejected only for the reused attachment's original request identity is reconciled read-only from the permanent record", async () => {
  const home = await temporaryHome();
  const fixture = await createRejectedAttachmentIdentityWedge(home, "acceptone");
  const result = await continueCueLineRun({
    runId: fixture.runId,
    home,
    conversationUrl: fixture.conversationUrl,
    browser: pageUntouchableBrowser(),
    routingConfig,
  });
  assert.equal(result.status, "complete");
  const events = await readEvents(runPaths(home, fixture.runId).events);
  const reconciled = events.find(
    (event) => event.type === "controller_response_reconciled",
  );
  assert.equal(
    (reconciled?.payload as Record<string, unknown> | undefined)?.request_id,
    fixture.originalRequestId,
  );
  const accepted = events.filter(
    (event) => event.type === "controller_command_accepted",
  );
  assert.equal(accepted.length, 1);
  assert.equal(
    (
      (accepted[0]?.payload as Record<string, unknown>).command as Record<
        string,
        unknown
      >
    ).request_id,
    fixture.originalRequestId,
  );
  const supersededRepair = events.find(
    (event) =>
      event.type === "controller_turn_abandoned" &&
      (event.payload as Record<string, unknown>).reason ===
        "superseded_by_reconciled_attachment_identity_response",
  );
  assert.equal(
    (supersededRepair?.payload as Record<string, unknown> | undefined)?.request_id,
    fixture.retryRequestId,
  );
  assert.equal(
    events.filter((event) => event.type === "controller_repair_requested").length,
    1,
  );
  assert.equal(
    events.some(
      (event) =>
        (event.type === "controller_turn_requested" ||
          event.type === "controller_repair_requested") &&
        (event.payload as Record<string, unknown>).round === 86,
    ),
    false,
  );
  const state = await loadCueLineRunState(fixture.runId, { home });
  assert.equal((state.pendingControllerTurns ?? []).length, 0);
  assert.equal(state.notSentRecovery ?? null, null);
});

test("reconciling the recorded response fails closed when it came from a different conversation", async () => {
  const home = await temporaryHome();
  const fixture = await createRejectedAttachmentIdentityWedge(home, "wrongconv", {
    recordedConversationUrl: "https://chatgpt.com/c/other-conversation-wrongconv",
  });
  await assert.rejects(
    continueCueLineRun({
      runId: fixture.runId,
      home,
      conversationUrl: fixture.conversationUrl,
      browser: pageUntouchableBrowser(),
      routingConfig,
    }),
    (error: unknown) =>
      (error as { code?: string }).code ===
      "CONTROLLER_RECONCILIATION_CONVERSATION_MISMATCH",
  );
  const events = await readEvents(runPaths(home, fixture.runId).events);
  assert.equal(
    events.filter((event) => event.type === "controller_repair_requested").length,
    1,
  );
  assert.equal(
    events.some((event) => event.type === "controller_command_accepted"),
    false,
  );
});

function callForbiddenBrowser(): BrowserAdapter {
  return new Proxy(
    {},
    {
      get(_target, property) {
        return () => {
          throw new Error(
            `REAL_RUNTIME_BROWSER_CALL_FORBIDDEN:${String(property)}`,
          );
        };
      },
    },
  ) as unknown as BrowserAdapter;
}

test("historical reconciliation pauses after accepting the recorded command instead of driving the next round", async () => {
  const home = await temporaryHome();
  const fixture = await createRejectedAttachmentIdentityWedge(home, "pauseboundary", {
    action: "wait",
  });
  await writeStaleSubmitterLease(home, fixture.runId, "2026-07-15T00:00:00.000Z");
  const takeover = await takeoverCueLineRuntime(fixture.runId, {
    home,
    now: () => new Date("2026-07-15T00:01:00.000Z"),
  });
  assert.equal(takeover.outcome, "taken_over");

  const first = await continueCueLineRun({
    runId: fixture.runId,
    home,
    conversationUrl: fixture.conversationUrl,
    browser: callForbiddenBrowser(),
    routingConfig,
  });
  assert.equal(first.status, "awaiting_controller");
  const events = await readEvents(runPaths(home, fixture.runId).events);
  assert.equal(
    events.some((event) => event.type === "run_failed"),
    false,
  );
  assert.equal(
    events.some(
      (event) =>
        event.type === "controller_turn_requested" &&
        (event.payload as Record<string, unknown>).round === 86,
    ),
    false,
  );
  const accepted = events.filter(
    (event) => event.type === "controller_command_accepted",
  );
  assert.equal(accepted.length, 1);
  const pausedState = await loadCueLineRunState(fixture.runId, { home });
  assert.equal((pausedState.pendingControllerTurns ?? []).length, 0);

  const secondRounds: number[] = [];
  const secondBrowser: BrowserAdapter = {
    submissionCheckpointContract: "write_ahead_v1",
    async sendTurn(input): Promise<ControllerTurn> {
      secondRounds.push(input.round);
      return {
        text: `<CueLineControl>${JSON.stringify({
          protocol: "cueline/0.1",
          run_id: fixture.runId,
          round: input.round,
          request_id: input.requestId,
          action: "complete",
          final_delivery_text: "ROUND86_DONE",
        })}</CueLineControl>`,
        conversationUrl: fixture.conversationUrl,
        model: {
          provider: "chatgpt",
          selectedLabel: "Pro",
          responseModelSlug: "gpt-5-6-pro",
          source: "composer_and_response",
        },
      };
    },
  };
  const second = await continueCueLineRun({
    runId: fixture.runId,
    home,
    conversationUrl: fixture.conversationUrl,
    browser: secondBrowser,
    routingConfig,
  });
  assert.equal(second.status, "complete");
  assert.deepEqual(secondRounds, [86]);
  const finalEvents = await readEvents(runPaths(home, fixture.runId).events);
  assert.equal(
    finalEvents.some(
      (event) =>
        event.type === "controller_turn_requested" &&
        (event.payload as Record<string, unknown>).round === 87,
    ),
    false,
  );
});

test("a round minted by the old fallthrough and blocked before submission can be formally confirmed not sent", async () => {
  const home = await temporaryHome();
  const fixture = await createRejectedAttachmentIdentityWedge(home, "pollutedround", {
    action: "wait",
  });
  const round86RequestId = "msg_round86_pollution_pollutedround";
  const store = await RunStore.load({
    home,
    runId: fixture.runId,
    initialState: initialRunState(fixture.runId, "unused", "caller", 100),
    reducer: reduceRunState,
  });
  await store.append("controller_response_received", {
    round: 85,
    request_id: fixture.originalRequestId,
    text: fixture.responseText,
    conversation_url: fixture.conversationUrl,
    selected_model_label: "Pro",
    response_model_slug: "gpt-5-6-pro",
    model_evidence_source: "composer_and_response",
  });
  await store.append("controller_response_reconciled", {
    round: 85,
    request_id: fixture.originalRequestId,
    repair_attempt: 0,
  });
  await store.append("controller_turn_abandoned", {
    round: 85,
    request_id: fixture.retryRequestId,
    reason: "superseded_by_reconciled_attachment_identity_response",
  });
  const acceptedCommand = {
    protocol: "cueline/0.1",
    run_id: fixture.runId,
    round: 85,
    request_id: fixture.originalRequestId,
    action: "wait",
  };
  await store.append("controller_command_accepted", {
    command: acceptedCommand,
    command_hash: commandHash(acceptedCommand),
  });
  await store.append("controller_command_execution_completed", {
    command_hash: commandHash(acceptedCommand),
  });
  const round86Prompt = `Round 86 controller observation pollutedround request ${round86RequestId}`;
  await store.append("controller_turn_requested", {
    round: 86,
    request_id: round86RequestId,
    prompt: round86Prompt,
    prompt_hash: commandHash(round86Prompt),
  });
  await store.append("run_failed", {
    code: "CUELINE_INTERNAL",
    message: "REAL_RUNTIME_BROWSER_CALL_FORBIDDEN:submitTurn",
    stage: "controller_turn",
    request_id: round86RequestId,
    submission_state: "requested",
    conversation_url: fixture.conversationUrl,
  });
  await store.snapshot();

  const observationBrowser: BrowserAdapter = {
    async sendTurn(): Promise<ControllerTurn> {
      throw new Error("not-sent confirmation must stay read-only");
    },
    async observeSubmittedTurn(): Promise<SubmittedTurnObservation> {
      return {
        status: "definitely_not_sent",
        evidence: {
          conversationUrl: fixture.conversationUrl,
          selectedModelLabel: "Pro",
          hydrated: true,
          baselineUserMessageCount: 102,
          observedUserMessageCount: 102,
          requestMessageFound: false,
          isAnswering: false,
          composerPromptState: "inline_ready",
          composerAttachmentCount: 0,
          composerSendButtonEnabled: true,
        },
      };
    },
  } as BrowserAdapter;
  const confirmation = await confirmControllerTurnNotSent(fixture.runId, {
    home,
    requestId: round86RequestId,
    conversationUrl: fixture.conversationUrl,
    browser: observationBrowser,
  });
  assert.equal(confirmation.outcome, "confirmed");
  const state = await loadCueLineRunState(fixture.runId, { home });
  assert.equal((state.pendingControllerTurns ?? []).length, 0);
  assert.equal(state.round, 85);
  assert.equal(state.notSentRecovery?.abandonedRequestId, round86RequestId);
  assert.equal(state.notSentRecovery?.status, "confirmed");
});

test("replay restores the reused attachment's controller identity from permanent events", async () => {
  const home = await temporaryHome();
  const fixture = await createRejectedAttachmentIdentityWedge(home, "replayid");
  const store = await RunStore.load({
    home,
    runId: fixture.runId,
    initialState: initialRunState(fixture.runId, "unused", "caller", 100),
    reducer: reduceRunState,
  });
  const pending = (store.state.pendingControllerTurns ?? [])[0];
  assert.equal(pending?.requestId, fixture.retryRequestId);
  assert.equal(store.state.notSentRecovery?.abandonedRequestId, fixture.originalRequestId);
  assert.equal(store.state.notSentRecovery?.retryRequestId, fixture.retryRequestId);
  assert.equal(store.state.notSentRecovery?.composerPromptState, "attachment_ready");
});
