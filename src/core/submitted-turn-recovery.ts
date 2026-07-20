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

export function isSubmittedTurnRecoveryCandidate(
  turn: PendingControllerTurn,
  conversationUrl: string,
): boolean {
  return (
    turn.submissionState === "submitted" &&
    hasRecoverableTurnIdentity(turn, conversationUrl)
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
  return (
    recoveryCandidate &&
    stagedComposerMatches &&
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
