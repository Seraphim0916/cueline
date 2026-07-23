import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  authorizeControllerDeliveryTimeoutRetry,
  continueCueLineRun,
  loadCueLineRunState,
  loadCueLineRunStatus,
  recordControllerDeliveryTimeoutAttestation,
} from "../../src/api.js";
import type {
  BrowserAdapter,
  BrowserDeliveryRetryHooks,
  BrowserDeliveryRetryInput,
  BrowserSubmissionTargetEvidence,
  BrowserSubmittedTurnEvidence,
  BrowserTurnInput,
  ControllerTurn,
} from "../../src/browser/browser-adapter.js";
import { deliveryTimeoutEvidenceHash } from "../../src/browser/delivery-timeout.js";
import { CueLineError } from "../../src/core/errors.js";
import { commandHash } from "../../src/core/ids.js";
import { initialRunState, reduceRunState } from "../../src/core/state-machine.js";
import { readEvents } from "../../src/state/event-log.js";
import { runPaths } from "../../src/state/paths.js";
import { RunStore } from "../../src/state/store.js";

const runId = "run_2707dc7332cd6d6f9c5c3d5cf21a33fd";
const requestId = "msg_4818cf41aaa098899904bc8c2a367f61";
const round = 198;
const conversationUrl =
  "https://chatgpt.com/c/6a5a679d-dd68-83ee-becb-7b7705ce886e";
const prompt = "round 198 attachment-backed controller request";

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
  return mkdtemp(path.join(tmpdir(), "cueline-delivery-timeout-"));
}

async function createSubmittedRound198(home: string): Promise<void> {
  const store = await RunStore.create({
    home,
    runId,
    initialState: initialRunState(runId, prompt, "caller", 200),
    reducer: reduceRunState,
  });
  await store.append("run_created", {
    request: prompt,
    executor: "caller",
    max_rounds: 200,
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
  await store.append("controller_turn_prompt_staged", {
    round,
    request_id: requestId,
    conversation_url: conversationUrl,
    selected_model_label: "Pro",
    composer_prompt_state: "attachment_ready",
    baseline_user_message_count: 211,
    baseline_assistant_message_count: 3,
  });
  await store.append("controller_turn_submission_started", {
    round,
    request_id: requestId,
    submission_state: "submitting",
    conversation_url: conversationUrl,
    selected_model_label: "Pro",
    composer_prompt_state: "attachment_ready",
    baseline_user_message_count: 211,
    baseline_assistant_message_count: 3,
  });
  await store.append("controller_turn_submitted", {
    round,
    request_id: requestId,
    submission_state: "submitted",
    conversation_url: conversationUrl,
    selected_model_label: "Pro",
    composer_prompt_state: "attachment_ready",
    baseline_user_message_count: 211,
    baseline_assistant_message_count: 3,
  });
  await store.snapshot();
}

function timeoutEvidence(): BrowserSubmittedTurnEvidence {
  return {
    conversationUrl,
    selectedModelLabel: "Pro",
    hydrated: true,
    baselineUserMessageCount: 211,
    observationBaselineUserMessageCount: 211,
    observedUserMessageCount: 212,
    countRegressionDetected: false,
    requestMessageFound: false,
    requestMessageFoundBy: "request_id_scan",
    requestMessageScanComplete: true,
    accessibilityRequestIdFound: null,
    isAnswering: false,
    composerPromptState: "empty",
    composerAttachmentCount: 0,
    composerPastedTextAttachmentPresent: false,
    composerSendButtonEnabled: false,
    assistantMessageCount: 4,
    lastMessageRole: "assistant",
    deliveryFailure: {
      code: "CHATGPT_MESSAGE_DELIVERY_TIMEOUT",
      message: "Message delivery timed out. Please try again.",
      assistantTextHash: commandHash(
        "Message delivery timed out. Please try again. Retry",
      ),
      retryActionAvailable: true,
    },
  };
}

function retryTargetEvidence(): BrowserSubmissionTargetEvidence {
  return {
    tabId: "delivery-timeout-target-tab",
    targetKind: "coordinate",
    coordinate: { x: 512, y: 300 },
    buttonRect: {
      x: 480,
      y: 280,
      width: 64,
      height: 40,
      top: 280,
      right: 544,
      bottom: 320,
      left: 480,
    },
    viewport: { width: 1440, height: 900 },
    devicePixelRatio: 2,
    elementFromPoint: null,
    elementFromPointButtonAncestor: null,
    elementFromPointMatchesButton: true,
    documentHasFocus: true,
    documentVisibilityState: "visible",
  };
}

function timeoutBrowser(evidence: BrowserSubmittedTurnEvidence): BrowserAdapter & {
  observeCalls: number;
  retryCalls: number;
  submitCalls: number;
  sendCalls: number;
} {
  let observeCalls = 0;
  let retryCalls = 0;
  let submitCalls = 0;
  let sendCalls = 0;
  return {
    submissionCheckpointContract: "write_ahead_v1",
    get observeCalls() { return observeCalls; },
    get retryCalls() { return retryCalls; },
    get submitCalls() { return submitCalls; },
    get sendCalls() { return sendCalls; },
    async observeSubmittedTurn(input: BrowserTurnInput) {
      observeCalls += 1;
      assert.equal(input.runId, runId);
      assert.equal(input.round, round);
      assert.equal(input.requestId, requestId);
      assert.equal(input.baselineUserMessageCount, 211);
      return { status: "delivery_failed" as const, evidence };
    },
    async retryDeliveryTimeout(
      input: BrowserDeliveryRetryInput,
      hooks?: BrowserDeliveryRetryHooks,
    ) {
      retryCalls += 1;
      assert.equal(input.runId, runId);
      assert.equal(input.round, round);
      assert.equal(input.requestId, requestId);
      assert.equal(input.expectedConversationUrl, conversationUrl);
      assert.equal(
        input.deliveryFailureEvidenceHash,
        deliveryTimeoutEvidenceHash(evidence),
      );
      assert.notEqual(hooks?.onBeforeRetryClick, undefined);
      await hooks!.onBeforeRetryClick!({
        evidence,
        evidenceHash: input.deliveryFailureEvidenceHash,
        targetEvidence: {
          tabId: "delivery-timeout-test-tab",
          targetKind: "coordinate",
          coordinate: { x: 512, y: 300 },
          buttonRect: {
            x: 480,
            y: 280,
            width: 64,
            height: 40,
            top: 280,
            right: 544,
            bottom: 320,
            left: 480,
          },
          viewport: { width: 1440, height: 900 },
          devicePixelRatio: 2,
          elementFromPoint: null,
          elementFromPointButtonAncestor: null,
          elementFromPointMatchesButton: true,
          documentHasFocus: true,
          documentVisibilityState: "visible",
        },
      });
      return { status: "submitted" as const, evidence };
    },
    async submitTurn(): Promise<void> {
      submitCalls += 1;
      throw new Error("delivery-timeout recovery must not submit a new prompt");
    },
    async observeTurn(): Promise<undefined> {
      return undefined;
    },
    async sendTurn(): Promise<ControllerTurn> {
      sendCalls += 1;
      throw new Error("delivery-timeout recovery must not send a new prompt");
    },
  };
}

test("delivery timeout is permanent, operator-gated, one-shot, and preserves round/request identity", async () => {
  const home = await temporaryHome();
  await createSubmittedRound198(home);
  const attestation = await recordControllerDeliveryTimeoutAttestation(runId, {
    home,
    requestId,
    round,
    conversationUrl,
    userTurnPresent: true,
    retryActionVisible: true,
    isAnswering: false,
    composerInlineTextLength: 0,
    composerAttachmentCount: 0,
    composerSendButtonEnabled: false,
  });
  assert.equal(attestation.outcome, "recorded");
  const evidence = timeoutEvidence();
  const evidenceHash = deliveryTimeoutEvidenceHash(evidence);
  const browser = timeoutBrowser(evidence);

  const observed = await continueCueLineRun({
    runId,
    home,
    browser,
    conversationUrl,
    routingConfig,
  });
  assert.equal(observed.status, "awaiting_controller");
  assert.equal(browser.observeCalls, 1);
  assert.equal(browser.retryCalls, 0);
  assert.equal(browser.submitCalls, 0);
  assert.equal(browser.sendCalls, 0);

  let status = await loadCueLineRunStatus(runId, { home });
  assert.equal(status.phase, "controller_delivery_failed");
  assert.equal(status.safeNextAction, "authorize_delivery_retry");
  assert.equal(status.controller.deliveryTimeout?.evidenceHash, evidenceHash);
  assert.equal(status.controller.deliveryTimeout?.status, "observed");

  const authorization = await authorizeControllerDeliveryTimeoutRetry(runId, {
    home,
    requestId,
    round,
    conversationUrl,
    evidenceHash,
  });
  assert.equal(authorization.outcome, "authorized");
  status = await loadCueLineRunStatus(runId, { home });
  assert.equal(status.phase, "controller_delivery_failed");
  assert.equal(status.safeNextAction, "retry_delivery_timeout");

  const retried = await continueCueLineRun({
    runId,
    home,
    browser,
    conversationUrl,
    routingConfig,
  });
  assert.equal(retried.status, "awaiting_controller");
  assert.equal(browser.observeCalls, 2);
  assert.equal(browser.retryCalls, 1);
  assert.equal(browser.submitCalls, 0);
  assert.equal(browser.sendCalls, 0);

  const state = await loadCueLineRunState(runId, { home });
  assert.equal(state.round, round);
  assert.equal(state.pendingControllerTurns.length, 1);
  assert.equal(state.pendingControllerTurns[0]?.round, round);
  assert.equal(state.pendingControllerTurns[0]?.requestId, requestId);
  assert.equal(state.controllerDeliveryTimeoutRecovery?.status, "consumed");
  const events = await readEvents(runPaths(home, runId).events);
  assert.equal(
    events.filter((event) => event.type === "controller_turn_requested").length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === "controller_delivery_timeout_operator_attested").length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === "controller_delivery_timeout_observed").length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === "controller_delivery_timeout_retry_started").length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === "controller_delivery_timeout_retry_submitted").length,
    1,
  );

  await continueCueLineRun({
    runId,
    home,
    browser,
    conversationUrl,
    routingConfig,
  });
  assert.equal(browser.retryCalls, 1);
  await assert.rejects(
    authorizeControllerDeliveryTimeoutRetry(runId, {
      home,
      requestId,
      round,
      conversationUrl,
      evidenceHash,
    }),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "CONTROLLER_DELIVERY_TIMEOUT_RETRY_EXHAUSTED",
  );
});

test("operator attestation alone cannot authorize Retry", async () => {
  const home = await temporaryHome();
  await createSubmittedRound198(home);
  await recordControllerDeliveryTimeoutAttestation(runId, {
    home,
    requestId,
    round,
    conversationUrl,
    userTurnPresent: true,
    retryActionVisible: true,
    isAnswering: false,
    composerInlineTextLength: 0,
    composerAttachmentCount: 0,
    composerSendButtonEnabled: false,
  });

  await assert.rejects(
    authorizeControllerDeliveryTimeoutRetry(runId, {
      home,
      requestId,
      round,
      conversationUrl,
      evidenceHash: deliveryTimeoutEvidenceHash(timeoutEvidence()),
    }),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "CONTROLLER_DELIVERY_TIMEOUT_RETRY_STATE_INVALID",
  );
});

test("a valid response that appears after timeout is reconciled read-only without Retry", async () => {
  const home = await temporaryHome();
  await createSubmittedRound198(home);
  const evidence = timeoutEvidence();
  const initialBrowser = timeoutBrowser(evidence);
  await continueCueLineRun({
    runId,
    home,
    browser: initialBrowser,
    conversationUrl,
    routingConfig,
  });
  let retryCalls = 0;
  const { deliveryFailure: _deliveryFailure, ...recoveredEvidence } = evidence;
  const recoveredBrowser: BrowserAdapter = {
    submissionCheckpointContract: "write_ahead_v1",
    async observeSubmittedTurn(input) {
      return {
        status: "response",
        evidence: recoveredEvidence,
        turn: {
          text: `<CueLineControl>${JSON.stringify({
            protocol: "cueline/0.1",
            run_id: input.runId,
            round: input.round,
            request_id: input.requestId,
            action: "dispatch",
            jobs: [{
              job_key: "resume_original_grove_session",
              lane: "default",
              mode: "work",
              task: "Continue the original Grove session after read-only reconcile",
              workdir: process.cwd(),
            }],
          })}</CueLineControl>`,
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
    async retryDeliveryTimeout() {
      retryCalls += 1;
      throw new Error("valid response must win before Retry");
    },
    async submitTurn(): Promise<void> {
      throw new Error("reconcile must not submit");
    },
    async observeTurn(): Promise<undefined> {
      return undefined;
    },
    async sendTurn(): Promise<ControllerTurn> {
      throw new Error("reconcile must not send");
    },
  };

  const result = await continueCueLineRun({
    runId,
    home,
    browser: recoveredBrowser,
    conversationUrl,
    routingConfig,
  });

  assert.equal(result.status, "awaiting_caller_work");
  assert.equal(retryCalls, 0);
  const state = await loadCueLineRunState(runId, { home });
  assert.equal(state.round, round);
  assert.equal(state.pendingControllerTurns.length, 0);
  assert.equal(state.controllerDeliveryTimeoutRecovery?.status, "resolved");
  assert.equal(Object.keys(state.jobs).length, 1);
  const events = await readEvents(runPaths(home, runId).events);
  assert.equal(
    events.filter((event) => event.type === "controller_turn_requested").length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === "controller_delivery_timeout_retry_started").length,
    0,
  );
  assert.equal(
    events.filter((event) => event.type === "controller_response_received").length,
    1,
  );
});

test("a valid response appearing after authorization consumption is reconciled without Retry submission", async () => {
  const home = await temporaryHome();
  await createSubmittedRound198(home);
  const evidence = timeoutEvidence();
  const evidenceHash = deliveryTimeoutEvidenceHash(evidence);
  await continueCueLineRun({
    runId,
    home,
    browser: timeoutBrowser(evidence),
    conversationUrl,
    routingConfig,
  });
  await authorizeControllerDeliveryTimeoutRetry(runId, {
    home,
    requestId,
    round,
    conversationUrl,
    evidenceHash,
  });

  let retryMethodCalls = 0;
  const raceBrowser: BrowserAdapter = {
    submissionCheckpointContract: "write_ahead_v1",
    async observeSubmittedTurn() {
      return { status: "delivery_failed", evidence };
    },
    async retryDeliveryTimeout(input, hooks) {
      retryMethodCalls += 1;
      await hooks!.onBeforeRetryClick!({
        evidence,
        evidenceHash: input.deliveryFailureEvidenceHash,
        targetEvidence: {
          tabId: "delivery-timeout-race-tab",
          targetKind: "coordinate",
          coordinate: { x: 512, y: 300 },
          buttonRect: {
            x: 480,
            y: 280,
            width: 64,
            height: 40,
            top: 280,
            right: 544,
            bottom: 320,
            left: 480,
          },
          viewport: { width: 1440, height: 900 },
          devicePixelRatio: 2,
          elementFromPoint: null,
          elementFromPointButtonAncestor: null,
          elementFromPointMatchesButton: true,
          documentHasFocus: true,
          documentVisibilityState: "visible",
        },
      });
      return {
        status: "response" as const,
        evidence,
        authorizationConsumed: true,
        turn: {
          text: `<CueLineControl>${JSON.stringify({
            protocol: "cueline/0.1",
            run_id: input.runId,
            round: input.round,
            request_id: input.requestId,
            action: "dispatch",
            jobs: [{
              job_key: "resume_original_grove_after_retry_race",
              lane: "default",
              mode: "work",
              task: "Continue the original Grove session after the Retry race was reconciled",
              workdir: process.cwd(),
            }],
          })}</CueLineControl>`,
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
      throw new Error("response-first recovery must not submit");
    },
    async observeTurn(): Promise<undefined> {
      return undefined;
    },
    async sendTurn(): Promise<ControllerTurn> {
      throw new Error("response-first recovery must not send");
    },
  };

  const result = await continueCueLineRun({
    runId,
    home,
    browser: raceBrowser,
    conversationUrl,
    routingConfig,
  });
  assert.equal(result.status, "awaiting_caller_work");
  assert.equal(retryMethodCalls, 1);

  const state = await loadCueLineRunState(runId, { home });
  assert.equal(state.round, round);
  assert.equal(state.pendingControllerTurns.length, 0);
  assert.equal(state.controllerDeliveryTimeoutRecovery?.status, "resolved");
  const events = await readEvents(runPaths(home, runId).events);
  assert.equal(
    events.filter((event) => event.type === "controller_turn_requested").length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === "controller_delivery_timeout_retry_started").length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === "controller_delivery_timeout_retry_skipped").length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === "controller_delivery_timeout_retry_submitted").length,
    0,
  );
  assert.equal(
    events.filter((event) => event.type === "controller_response_received").length,
    1,
  );
});

test("an atomic target change after authorization is permanently skipped without identity drift", async () => {
  const home = await temporaryHome();
  await createSubmittedRound198(home);
  const evidence = timeoutEvidence();
  const evidenceHash = deliveryTimeoutEvidenceHash(evidence);
  await continueCueLineRun({
    runId,
    home,
    browser: timeoutBrowser(evidence),
    conversationUrl,
    routingConfig,
  });
  await authorizeControllerDeliveryTimeoutRetry(runId, {
    home,
    requestId,
    round,
    conversationUrl,
    evidenceHash,
  });

  let retryMethodCalls = 0;
  const changedTargetBrowser: BrowserAdapter = {
    submissionCheckpointContract: "write_ahead_v1",
    async observeSubmittedTurn() {
      return { status: "delivery_failed", evidence };
    },
    async retryDeliveryTimeout(input, hooks) {
      retryMethodCalls += 1;
      await hooks!.onBeforeRetryClick!({
        evidence,
        evidenceHash: input.deliveryFailureEvidenceHash,
        targetEvidence: retryTargetEvidence(),
      });
      return {
        status: "not_clicked" as const,
        evidence,
        authorizationConsumed: true as const,
        reason: "target_changed",
      };
    },
    async submitTurn(): Promise<void> {
      throw new Error("target-change recovery must not submit");
    },
    async observeTurn(): Promise<undefined> {
      return undefined;
    },
    async sendTurn(): Promise<ControllerTurn> {
      throw new Error("target-change recovery must not send");
    },
  };

  const result = await continueCueLineRun({
    runId,
    home,
    browser: changedTargetBrowser,
    conversationUrl,
    routingConfig,
  });
  assert.equal(result.status, "awaiting_controller");
  assert.equal(retryMethodCalls, 1);

  const repeated = await continueCueLineRun({
    runId,
    home,
    browser: changedTargetBrowser,
    conversationUrl,
    routingConfig,
  });
  assert.equal(repeated.status, "awaiting_controller");
  assert.equal(retryMethodCalls, 1);

  const state = await loadCueLineRunState(runId, { home });
  assert.equal(state.round, round);
  assert.equal(state.pendingControllerTurns.length, 1);
  assert.equal(state.pendingControllerTurns[0]?.requestId, requestId);
  assert.equal(state.controllerDeliveryTimeoutRecovery?.status, "consumed");
  const events = await readEvents(runPaths(home, runId).events);
  assert.equal(
    events.filter((event) => event.type === "controller_turn_requested").length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === "controller_delivery_timeout_retry_started").length,
    1,
  );
  const skipped = events.filter(
    (event) => event.type === "controller_delivery_timeout_retry_skipped",
  );
  assert.equal(skipped.length, 1);
  const skippedPayload = skipped[0]!.payload as Record<string, unknown>;
  assert.equal(skippedPayload.request_id, requestId);
  assert.equal(skippedPayload.round, round);
  assert.equal(skippedPayload.reason, "target_changed");
  assert.equal(skippedPayload.retry_clicked, false);
  assert.equal(
    events.filter((event) => event.type === "controller_delivery_timeout_retry_submitted").length,
    0,
  );
});
