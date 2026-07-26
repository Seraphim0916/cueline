import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  BrowserAdapter,
  BrowserSubmittedTurnObservation,
  BrowserTurnInput,
} from "../../src/browser/browser-adapter.js";
import {
  confirmControllerTurnNotSent,
  loadCueLineRunState,
} from "../../src/api.js";
import { CueLineError } from "../../src/core/errors.js";
import { commandHash } from "../../src/core/ids.js";
import {
  initialRunState,
  reduceRunState,
} from "../../src/core/state-machine.js";
import { RunStore } from "../../src/state/store.js";

const conversationUrl =
  "https://chatgpt.com/c/submitted-empty-composer-recovery";
const baselineUserMessageCount = 305;

async function createSubmittedAttachmentTurn(suffix: string): Promise<{
  home: string;
  runId: string;
  requestId: string;
}> {
  const home = await mkdtemp(
    path.join(tmpdir(), "cueline-submitted-empty-composer-"),
  );
  const runId = `run_submitted_empty_${suffix}`;
  const requestId = `msg_submitted_empty_${suffix}`;
  const prompt = `Submitted attachment recovery ${suffix}`;
  const promptHash = commandHash(prompt);
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
    round: 97,
    request_id: requestId,
    prompt,
    prompt_hash: promptHash,
    submission_checkpoint_contract: "write_ahead_v1",
  });
  await store.append("controller_turn_prompt_staged", {
    round: 97,
    request_id: requestId,
    conversation_url: conversationUrl,
    selected_model_label: "Pro",
    prompt_hash: promptHash,
    composer_prompt_state: "attachment_ready",
    baseline_user_message_count: baselineUserMessageCount,
    baseline_assistant_message_count: 3,
  });
  await store.append("controller_turn_submission_started", {
    round: 97,
    request_id: requestId,
    submission_state: "submitting",
    conversation_url: conversationUrl,
    selected_model_label: "Pro",
    prompt_hash: promptHash,
    model_evidence_source: "composer",
    composer_prompt_state: "attachment_ready",
    baseline_user_message_count: baselineUserMessageCount,
    baseline_assistant_message_count: 3,
    click_attempt_state: "attempting",
  });
  await store.append("controller_turn_submitted", {
    round: 97,
    request_id: requestId,
    submission_state: "submitted",
    conversation_url: conversationUrl,
    selected_model_label: "Pro",
    prompt_hash: promptHash,
    model_evidence_source: "composer",
    composer_prompt_state: "attachment_ready",
    baseline_user_message_count: baselineUserMessageCount,
    baseline_assistant_message_count: 3,
    click_attempt_state: "accepted",
  });
  await store.snapshot();
  return { home, runId, requestId };
}

function emptyComposerBrowser(
  accessibilityRequestIdFound: boolean | null,
  onInput?: (input: BrowserTurnInput) => void,
): BrowserAdapter {
  return {
    submissionCheckpointContract: "write_ahead_v1",
    async observeSubmittedTurn(
      input,
    ): Promise<BrowserSubmittedTurnObservation> {
      onInput?.(input);
      return {
        status: "definitely_not_sent",
        evidence: {
          conversationUrl,
          selectedModelLabel: "Pro",
          hydrated: true,
          baselineUserMessageCount,
          observationBaselineUserMessageCount: baselineUserMessageCount,
          observedUserMessageCount: baselineUserMessageCount,
          countRegressionDetected: false,
          requestMessageFound: false,
          requestMessageFoundBy: null,
          requestMessageScanComplete: true,
          accessibilityRequestIdFound,
          assistantTextFoundBy: "last_message",
          isAnswering: false,
          composerPromptState: "empty",
          composerAttachmentCount: 0,
          composerPastedTextAttachmentPresent: false,
          composerSendButtonEnabled: false,
          assistantMessageCount: 3,
          lastMessageRole: "assistant",
        },
      };
    },
    async sendTurn() {
      throw new Error("not used");
    },
  };
}

test("submitted attachment missing after reload is recoverable with exact dual-source absence proof", async () => {
  const fixture = await createSubmittedAttachmentTurn("positive");
  const browser = emptyComposerBrowser(false, (input) => {
    assert.equal(input.attachmentPromptExpected, true);
    assert.equal(input.emptyComposerNotSentRecovery, true);
  });

  const confirmation = await confirmControllerTurnNotSent(fixture.runId, {
    home: fixture.home,
    requestId: fixture.requestId,
    conversationUrl,
    browser,
  });

  assert.equal(confirmation.outcome, "confirmed");
  const state = await loadCueLineRunState(fixture.runId, {
    home: fixture.home,
  });
  assert.equal(state.pendingControllerTurns.length, 0);
  assert.equal(state.notSentRecovery?.abandonedRequestId, fixture.requestId);
});

test("submitted attachment missing after reload stays frozen without accessibility absence proof", async () => {
  const fixture = await createSubmittedAttachmentTurn("unproven");

  await assert.rejects(
    confirmControllerTurnNotSent(fixture.runId, {
      home: fixture.home,
      requestId: fixture.requestId,
      conversationUrl,
      browser: emptyComposerBrowser(null),
    }),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "CONTROLLER_NOT_SENT_EVIDENCE_INSUFFICIENT",
  );
});
