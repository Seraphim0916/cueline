import type { BrowserSubmittedTurnEvidence } from "../browser/browser-adapter.js";
import {
  isExactChatGptConversationUrl,
  sameChatGptConversationUrl,
} from "./conversation-url.js";
import type { PendingControllerTurn } from "./state-machine.js";

export function hasRecoverableTurnIdentity(
  turn: PendingControllerTurn,
  conversationUrl: string,
): boolean {
  return (
    turn.manualSendConfirmed === false &&
    (turn.retryOfRequestId === undefined || turn.retryOfRequestId === null) &&
    turn.submissionCheckpointContract === "write_ahead_v1" &&
    Number.isSafeInteger(turn.baselineUserMessageCount) &&
    (turn.baselineUserMessageCount ?? -1) >= 0 &&
    /^[0-9a-f]{64}$/.test(turn.promptHash) &&
    turn.selectedModelLabel !== null &&
    /^Pro(?:\s|$)/i.test(turn.selectedModelLabel) &&
    isExactChatGptConversationUrl(conversationUrl)
  );
}

function hasManualConfirmedTurnIdentity(
  turn: PendingControllerTurn,
  conversationUrl: string,
): boolean {
  return (
    turn.manualSendConfirmed === true &&
    (turn.retryOfRequestId === undefined || turn.retryOfRequestId === null) &&
    turn.submissionCheckpointContract === "write_ahead_v1" &&
    Number.isSafeInteger(turn.baselineUserMessageCount) &&
    (turn.baselineUserMessageCount ?? -1) >= 0 &&
    /^[0-9a-f]{64}$/.test(turn.promptHash) &&
    turn.selectedModelLabel !== null &&
    /^Pro(?:\s|$)/i.test(turn.selectedModelLabel) &&
    isExactChatGptConversationUrl(conversationUrl)
  );
}

export function isSubmittedTurnRecoveryCandidate(
  turn: PendingControllerTurn,
  conversationUrl: string,
): boolean {
  return (
    (turn.submissionState === "submitted" &&
      hasRecoverableTurnIdentity(turn, conversationUrl)) ||
    ((turn.submissionState === "submitted" ||
      turn.submissionState === "possibly_sent") &&
      hasManualConfirmedTurnIdentity(turn, conversationUrl))
  );
}

export function isSubmissionStartedAttachmentRecoveryCandidate(
  turn: PendingControllerTurn,
  conversationUrl: string,
): boolean {
  return (
    turn.submissionState === "submitting" &&
    turn.composerPromptState === "attachment_ready" &&
    hasRecoverableTurnIdentity(turn, conversationUrl)
  );
}

export function isDefinitelyNotSentObservation(
  turn: PendingControllerTurn,
  expectedConversationUrl: string,
  evidence: BrowserSubmittedTurnEvidence,
): boolean {
  const recoveryCandidate =
    isSubmittedTurnRecoveryCandidate(turn, expectedConversationUrl) ||
    isSubmissionStartedAttachmentRecoveryCandidate(turn, expectedConversationUrl);
  const stagedComposerMatches =
    turn.composerPromptState === "attachment_ready"
      ? evidence.composerPromptState === "attachment_ready" &&
        Number.isSafeInteger(evidence.composerAttachmentCount) &&
        (evidence.composerAttachmentCount ?? 0) > 0 &&
        evidence.composerSendButtonEnabled === true
      : turn.composerPromptState === "inline_ready"
      ? evidence.composerPromptState === "inline_ready" &&
        evidence.composerSendButtonEnabled === true
      : false;
  const branchLocalBaselineEqual =
    evidence.branchLeafMismatch?.code ===
      "CONTROLLER_OBSERVATION_BRANCH_LEAF_MISMATCH" &&
    evidence.branchLeafMismatch.expectedRound === turn.round &&
    evidence.branchLeafMismatch.expectedRequestId === turn.requestId &&
    evidence.branchLeafMismatch.branchSearchPerformed === true &&
    evidence.branchLeafMismatch.branchSearchFoundExactEnvelope === false &&
    evidence.branchLeafMismatch.branchLocalUserMessageCount ===
      turn.baselineUserMessageCount;
  const emptyComposerProvesReloadedAttachmentWasNotPersisted =
    turn.submissionState === "submitted" &&
    turn.composerPromptState === "attachment_ready" &&
    evidence.composerPromptState === "empty" &&
    evidence.composerAttachmentCount === 0 &&
    evidence.composerPastedTextAttachmentPresent !== true &&
    evidence.composerSendButtonEnabled === false &&
    evidence.requestMessageScanComplete === true &&
    evidence.accessibilityRequestIdFound === false &&
    evidence.countRegressionDetected !== true &&
    (evidence.observedUserMessageCount === turn.baselineUserMessageCount ||
      branchLocalBaselineEqual);
  return (
    recoveryCandidate &&
    (stagedComposerMatches ||
      emptyComposerProvesReloadedAttachmentWasNotPersisted) &&
    evidence.hydrated === true &&
    evidence.requestMessageFound === false &&
    evidence.isAnswering === false &&
    evidence.selectedModelLabel !== null &&
    /^Pro(?:\s|$)/i.test(evidence.selectedModelLabel) &&
    evidence.baselineUserMessageCount === turn.baselineUserMessageCount &&
    Number.isSafeInteger(evidence.observedUserMessageCount) &&
    (evidence.observedUserMessageCount ?? -1) >= evidence.baselineUserMessageCount &&
    isExactChatGptConversationUrl(evidence.conversationUrl) &&
    sameChatGptConversationUrl(evidence.conversationUrl, expectedConversationUrl)
  );
}
