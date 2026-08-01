import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  authorizeControllerResponseRetry,
  continueCueLineRun,
  loadCueLineRunState,
  loadCueLineRunStatus,
} from "../../src/api.js";
import type {
  BrowserAdapter,
  BrowserSubmittedTurnEvidence,
  BrowserTurnHooks,
  BrowserTurnInput,
  ControllerTurn,
} from "../../src/browser/browser-adapter.js";
import { controllerResponseFailureEvidenceHash } from "../../src/browser/controller-response-failure.js";
import { CueLineError } from "../../src/core/errors.js";
import { commandHash } from "../../src/core/ids.js";
import { initialRunState, reduceRunState } from "../../src/core/state-machine.js";
import { readEvents } from "../../src/state/event-log.js";
import { runPaths } from "../../src/state/paths.js";
import { RunStore } from "../../src/state/store.js";

const runId = "run_e3e52e6445e39db8e20e46485e084651";
const requestId = "msg_3a53c64ee7c85cf4045dcc91472920ba";
const round = 24;
const conversationUrl =
  "https://chatgpt.com/c/6a58682a-f1ec-83ee-a6f9-64298ea03d15";
const prompt = `round 24 exact controller request ${requestId}`;

const routingConfig = {
  version: 1 as const,
  lanes: {
    default: {
      enabled: true,
      candidates: [{
        id: "node",
        argv: [process.execPath, "-e", "process.stdout.write('unused')"],
        task_input: "stdin" as const,
      }],
    },
  },
};

async function temporaryHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "cueline-thinking-failed-"));
}

async function createSubmittedRound24(home: string): Promise<void> {
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
  await store.append("controller_conversation_bound", {
    conversation_url: conversationUrl,
  });
  await store.append("controller_turn_requested", {
    round,
    request_id: requestId,
    prompt,
    prompt_hash: commandHash(prompt),
    submission_checkpoint_contract: "write_ahead_v1",
  });
  const checkpoint = {
    round,
    request_id: requestId,
    conversation_url: conversationUrl,
    selected_model_label: "Pro",
    baseline_user_message_count: 31,
    baseline_assistant_message_count: 23,
    composer_prompt_state: "inline_ready",
  };
  await store.append("controller_turn_prompt_staged", checkpoint);
  await store.append("controller_turn_submission_started", {
    ...checkpoint,
    submission_state: "submitting",
  });
  await store.append("controller_turn_submitted", {
    ...checkpoint,
    submission_state: "submitted",
  });
  await store.snapshot();
}

function thinkingFailedEvidence(
  overrides: Partial<BrowserSubmittedTurnEvidence> = {},
): BrowserSubmittedTurnEvidence {
  return {
    conversationUrl,
    selectedModelLabel: "Pro",
    hydrated: true,
    baselineUserMessageCount: 31,
    observationBaselineUserMessageCount: 31,
    observedUserMessageCount: 32,
    countRegressionDetected: false,
    requestMessageFound: true,
    requestMessageFoundBy: "last_text",
    requestMessageScanComplete: true,
    accessibilityRequestIdFound: null,
    isAnswering: false,
    composerPromptState: "empty",
    composerAttachmentCount: 0,
    composerPastedTextAttachmentPresent: false,
    composerSendButtonEnabled: false,
    assistantMessageCount: 24,
    lastMessageRole: "assistant",
    responseFailure: {
      code: "CHATGPT_THINKING_FAILED",
      message: "Thinking failed",
      assistantTextHash: commandHash("Thinking failed"),
      retryActionAvailable: false,
    },
    ...overrides,
  };
}

function observationBrowser(
  evidence: BrowserSubmittedTurnEvidence,
): BrowserAdapter {
  return {
    submissionCheckpointContract: "write_ahead_v1",
    async observeSubmittedTurn() {
      return { status: "response_failed" as const, evidence };
    },
    async submitTurn(): Promise<void> {
      throw new Error("unapproved response failure must not submit");
    },
    async observeTurn(): Promise<undefined> {
      return undefined;
    },
    async sendTurn(): Promise<ControllerTurn> {
      throw new Error("unapproved response failure must not send");
    },
  };
}

test("Thinking failed becomes an exact durable controller response failure with zero resend", async () => {
  const home = await temporaryHome();
  await createSubmittedRound24(home);
  const evidence = thinkingFailedEvidence();

  const result = await continueCueLineRun({
    runId,
    home,
    browser: observationBrowser(evidence),
    conversationUrl,
    routingConfig,
  });

  assert.equal(result.status, "awaiting_controller");
  const status = await loadCueLineRunStatus(runId, { home });
  assert.equal(status.phase, "controller_response_failed");
  assert.equal(status.safeNextAction, "authorize_controller_response_retry");
  assert.deepEqual(status.controller.responseFailure, {
    requestId,
    round,
    code: "CHATGPT_THINKING_FAILED",
    evidenceHash: controllerResponseFailureEvidenceHash(evidence),
    retryActionAvailable: false,
    status: "observed",
  });
  const events = await readEvents(runPaths(home, runId).events);
  assert.equal(
    events.filter((event) => event.type === "controller_response_failure_observed").length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === "controller_turn_requested").length,
    1,
  );
});

test("exact authorization consumes before one same-round resend and restart never duplicates", async () => {
  const home = await temporaryHome();
  await createSubmittedRound24(home);
  const evidence = thinkingFailedEvidence();
  const evidenceHash = controllerResponseFailureEvidenceHash(evidence);
  await continueCueLineRun({
    runId,
    home,
    browser: observationBrowser(evidence),
    conversationUrl,
    routingConfig,
  });
  await authorizeControllerResponseRetry(runId, {
    home,
    requestId,
    round,
    conversationUrl,
    evidenceHash,
  });

  const submissions: BrowserTurnInput[] = [];
  const retryBrowser: BrowserAdapter = {
    submissionCheckpointContract: "write_ahead_v1",
    async observeSubmittedTurn() {
      return { status: "response_failed" as const, evidence };
    },
    async submitTurn(input: BrowserTurnInput, hooks: BrowserTurnHooks = {}) {
      submissions.push(structuredClone(input));
      assert.equal(input.round, round);
      assert.notEqual(input.requestId, requestId);
      assert.equal(input.notSentRecovery?.abandonedRequestId, requestId);
      assert.equal(input.expectedConversationUrl, conversationUrl);
      await hooks.onCheckpoint?.({
        submissionState: "submitting",
        composerPromptState: "inline_ready",
        conversationUrl,
        selectedModelLabel: "Pro",
        baselineUserMessageCount: 32,
        baselineAssistantMessageCount: 24,
      });
      await hooks.onCheckpoint?.({
        submissionState: "submitted",
        composerPromptState: "inline_ready",
        conversationUrl,
        selectedModelLabel: "Pro",
        baselineUserMessageCount: 32,
        baselineAssistantMessageCount: 24,
      });
    },
    async observeTurn(): Promise<undefined> {
      return undefined;
    },
    async sendTurn(): Promise<ControllerTurn> {
      throw new Error("caller mode should use submitTurn");
    },
  };

  const retryResult = await continueCueLineRun({
    runId,
    home,
    browser: retryBrowser,
    conversationUrl,
    routingConfig,
  });
  assert.equal(retryResult.status, "awaiting_controller");
  assert.equal(submissions.length, 1);

  const state = await loadCueLineRunState(runId, { home });
  assert.equal(state.round, round);
  assert.equal(state.pendingControllerTurns.length, 1);
  assert.notEqual(state.pendingControllerTurns[0]!.requestId, requestId);
  assert.equal(state.pendingControllerTurns[0]!.retryOfRequestId, requestId);
  assert.equal(state.controllerResponseFailureRecovery?.status, "resent");
  assert.equal(
    state.controllerResponseFailureRecovery?.retryRequestId,
    state.pendingControllerTurns[0]!.requestId,
  );

  let restartSubmissions = 0;
  const pendingEvidence = thinkingFailedEvidence();
  delete pendingEvidence.responseFailure;
  const restartBrowser: BrowserAdapter = {
    submissionCheckpointContract: "write_ahead_v1",
    async observeSubmittedTurn() {
      return { status: "pending" as const, evidence: {
        ...pendingEvidence,
        baselineUserMessageCount: 32,
        observedUserMessageCount: 33,
        assistantMessageCount: 24,
        lastMessageRole: "user",
      } };
    },
    async submitTurn(): Promise<void> {
      restartSubmissions += 1;
    },
    async observeTurn(): Promise<undefined> {
      return undefined;
    },
    async sendTurn(): Promise<ControllerTurn> {
      throw new Error("restart must observe only");
    },
  };
  await continueCueLineRun({
    runId,
    home,
    browser: restartBrowser,
    conversationUrl,
    routingConfig,
  });
  assert.equal(restartSubmissions, 0);
  const events = await readEvents(runPaths(home, runId).events);
  const requested = events.filter((event) => event.type === "controller_turn_requested");
  assert.equal(requested.length, 2);
  assert.equal(
    events.filter((event) =>
      event.type === "controller_response_retry_authorization_consumed"
    ).length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === "controller_response_retry_resent").length,
    1,
  );
});

test("non-Pro Thinking failed evidence cannot authorize or resend", async () => {
  const home = await temporaryHome();
  await createSubmittedRound24(home);
  const evidence = thinkingFailedEvidence({ selectedModelLabel: "GPT-5" });
  await continueCueLineRun({
    runId,
    home,
    browser: observationBrowser(evidence),
    conversationUrl,
    routingConfig,
  });
  const status = await loadCueLineRunStatus(runId, { home });
  assert.equal(status.phase, "controller_response_pending");
  await assert.rejects(
    authorizeControllerResponseRetry(runId, {
      home,
      requestId,
      round,
      conversationUrl,
      evidenceHash: controllerResponseFailureEvidenceHash(evidence),
    }),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "CONTROLLER_RESPONSE_RETRY_STATE_INVALID",
  );
});

test("restart after authorization consumption but before send is fail-closed", async () => {
  const home = await temporaryHome();
  await createSubmittedRound24(home);
  const evidence = thinkingFailedEvidence();
  const evidenceHash = controllerResponseFailureEvidenceHash(evidence);
  await continueCueLineRun({
    runId,
    home,
    browser: observationBrowser(evidence),
    conversationUrl,
    routingConfig,
  });
  await authorizeControllerResponseRetry(runId, {
    home,
    requestId,
    round,
    conversationUrl,
    evidenceHash,
  });
  const store = await RunStore.load({
    home,
    runId,
    initialState: initialRunState(runId, ""),
    reducer: reduceRunState,
  });
  await store.append("controller_response_retry_authorization_consumed", {
    round,
    request_id: requestId,
    prompt_hash: commandHash(prompt),
    conversation_url: conversationUrl,
    evidence_hash: evidenceHash,
    authorization_consumed_before_composer_mutation: true,
    one_shot: true,
  });
  await store.append("controller_turn_abandoned", {
    round,
    request_id: requestId,
    reason: "controller_response_retry_authorized",
    round_not_consumed: true,
  });
  await store.snapshot();

  let submissions = 0;
  const browser: BrowserAdapter = {
    submissionCheckpointContract: "write_ahead_v1",
    async submitTurn(): Promise<void> {
      submissions += 1;
    },
    async observeTurn(): Promise<undefined> {
      return undefined;
    },
    async sendTurn(): Promise<ControllerTurn> {
      throw new Error("consumed crash state must not send");
    },
  };
  await assert.rejects(
    continueCueLineRun({
      runId,
      home,
      browser,
      conversationUrl,
      routingConfig,
    }),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "CONTROLLER_RESPONSE_RETRY_REVIEW_REQUIRED",
  );
  assert.equal(submissions, 0);
});

test("authorized response retry is permanently skipped when DOM failure changes", async () => {
  const home = await temporaryHome();
  await createSubmittedRound24(home);
  const evidence = thinkingFailedEvidence();
  const evidenceHash = controllerResponseFailureEvidenceHash(evidence);
  await continueCueLineRun({
    runId,
    home,
    browser: observationBrowser(evidence),
    conversationUrl,
    routingConfig,
  });
  await authorizeControllerResponseRetry(runId, {
    home,
    requestId,
    round,
    conversationUrl,
    evidenceHash,
  });
  const changedEvidence = thinkingFailedEvidence();
  delete changedEvidence.responseFailure;
  changedEvidence.isAnswering = true;
  let submissions = 0;
  const browser: BrowserAdapter = {
    submissionCheckpointContract: "write_ahead_v1",
    async observeSubmittedTurn() {
      return { status: "pending" as const, evidence: changedEvidence };
    },
    async submitTurn(): Promise<void> {
      submissions += 1;
    },
    async observeTurn(): Promise<undefined> {
      return undefined;
    },
    async sendTurn(): Promise<ControllerTurn> {
      throw new Error("changed DOM must not send");
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
  assert.equal(submissions, 0);
  const state = await loadCueLineRunState(runId, { home });
  assert.equal(state.controllerResponseFailureRecovery?.status, "skipped");
  const events = await readEvents(runPaths(home, runId).events);
  assert.equal(
    events.filter((event) => event.type === "controller_response_retry_skipped").length,
    1,
  );
});
