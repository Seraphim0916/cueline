import type { BrowserSubmittedTurnEvidence } from "../browser/browser-adapter.js";
import {
  isExactChatGptConversationUrl,
  sameChatGptConversationUrl,
} from "./conversation-url.js";
import type { PendingControllerTurn } from "./state-machine.js";

export function isSubmittedTurnRecoveryCandidate(
  turn: PendingControllerTurn,
  conversationUrl: string,
): boolean {
  return (
    turn.submissionState === "submitted" &&
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

export function isDefinitelyNotSentObservation(
  turn: PendingControllerTurn,
  expectedConversationUrl: string,
  evidence: BrowserSubmittedTurnEvidence,
): boolean {
  return (
    isSubmittedTurnRecoveryCandidate(turn, expectedConversationUrl) &&
    evidence.hydrated === true &&
    evidence.requestMessageFound === false &&
    evidence.isAnswering === false &&
    evidence.selectedModelLabel !== null &&
    /^Pro(?:\s|$)/i.test(evidence.selectedModelLabel) &&
    evidence.baselineUserMessageCount === turn.baselineUserMessageCount &&
    Number.isSafeInteger(evidence.observedUserMessageCount) &&
    evidence.observedUserMessageCount === turn.baselineUserMessageCount &&
    isExactChatGptConversationUrl(evidence.conversationUrl) &&
    sameChatGptConversationUrl(evidence.conversationUrl, expectedConversationUrl)
  );
}
