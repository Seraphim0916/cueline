import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserSubmittedTurnEvidence } from "../../src/browser/browser-adapter.js";
import {
  isDefinitelyNotSentObservation,
  isSubmittedTurnRecoveryCandidate,
} from "../../src/core/submitted-turn-recovery.js";
import type { PendingControllerTurn } from "../../src/core/state-machine.js";

const conversationUrl = "https://chatgpt.com/c/branch-local-recovery";
const requestId = "msg_fc053647e94f54b2a5de96a3a00b11fd";

function pendingTurn(): PendingControllerTurn {
  return {
    round: 5,
    requestId,
    manualSendConfirmed: false,
    retryOfRequestId: null,
    submissionCheckpointContract: "write_ahead_v1",
    baselineUserMessageCount: 448,
    promptHash: "a".repeat(64),
    selectedModelLabel: "Pro",
    submissionState: "submitted",
    composerPromptState: "attachment_ready",
  } as PendingControllerTurn;
}

function branchLocalEvidence(
  overrides: Partial<BrowserSubmittedTurnEvidence> = {},
): BrowserSubmittedTurnEvidence {
  return {
    conversationUrl,
    selectedModelLabel: "Pro",
    hydrated: true,
    baselineUserMessageCount: 448,
    observedUserMessageCount: 452,
    requestMessageFound: false,
    requestMessageScanComplete: true,
    accessibilityRequestIdFound: false,
    isAnswering: false,
    composerPromptState: "empty",
    composerAttachmentCount: 0,
    composerPastedTextAttachmentPresent: false,
    composerSendButtonEnabled: false,
    branchLeafMismatch: {
      code: "CONTROLLER_OBSERVATION_BRANCH_LEAF_MISMATCH",
      expectedRound: 5,
      expectedRequestId: requestId,
      observedRunId: "run_branch_local_recovery",
      observedRound: 4,
      observedRequestId: "msg_round_4",
      branchSearchPerformed: true,
      branchSearchSource: "accessibility_snapshot",
      branchSearchFoundExactEnvelope: false,
      branchLocalUserMessageCount: 448,
    },
    ...overrides,
  };
}

test("accepts aggregate uplift only when current-leaf count remains baseline-equal", () => {
  assert.equal(
    isDefinitelyNotSentObservation(
      pendingTurn(),
      conversationUrl,
      branchLocalEvidence(),
    ),
    true,
  );
});

test("accepts exact manual-confirmed possibly-sent turn for response recovery", () => {
  const turn = pendingTurn();
  turn.submissionState = "possibly_sent";
  turn.manualSendConfirmed = true;
  assert.equal(isSubmittedTurnRecoveryCandidate(turn, conversationUrl), true);
});

test("accepts exact manual-confirmed submitted turn for response recovery", () => {
  const turn = pendingTurn();
  turn.manualSendConfirmed = true;
  assert.equal(isSubmittedTurnRecoveryCandidate(turn, conversationUrl), true);
});

test("rejects possibly-sent turn without manual confirmation", () => {
  const turn = pendingTurn();
  turn.submissionState = "possibly_sent";
  assert.equal(isSubmittedTurnRecoveryCandidate(turn, conversationUrl), false);
});

test("rejects non-current exact envelope and non-baseline current-leaf count", () => {
  const exactEnvelopeElsewhere = branchLocalEvidence();
  exactEnvelopeElsewhere.branchLeafMismatch!.branchSearchFoundExactEnvelope = true;
  assert.equal(
    isDefinitelyNotSentObservation(
      pendingTurn(),
      conversationUrl,
      exactEnvelopeElsewhere,
    ),
    false,
  );

  const currentLeafAdvanced = branchLocalEvidence();
  currentLeafAdvanced.branchLeafMismatch!.branchLocalUserMessageCount = 449;
  assert.equal(
    isDefinitelyNotSentObservation(
      pendingTurn(),
      conversationUrl,
      currentLeafAdvanced,
    ),
    false,
  );
});
