import { commandHash } from "../core/ids.js";
import type { BrowserSubmittedTurnEvidence } from "./browser-adapter.js";

export const CHATGPT_DELIVERY_TIMEOUT_CODE =
  "CHATGPT_MESSAGE_DELIVERY_TIMEOUT" as const;
export const CHATGPT_DELIVERY_TIMEOUT_MESSAGE =
  "Message delivery timed out. Please try again." as const;

/**
 * Stable identity for the exact read-only DOM proof that gates a one-shot
 * delivery-timeout Retry. Volatile pending diagnostics are deliberately
 * excluded so waiting longer cannot silently change the authorization target.
 */
export function deliveryTimeoutEvidenceHash(
  evidence: BrowserSubmittedTurnEvidence,
): string {
  return commandHash({
    schema: "cueline/controller-delivery-timeout-evidence/v1",
    conversation_url: evidence.conversationUrl,
    selected_model_label: evidence.selectedModelLabel,
    hydrated: evidence.hydrated,
    baseline_user_message_count: evidence.baselineUserMessageCount,
    observation_baseline_user_message_count:
      evidence.observationBaselineUserMessageCount ?? null,
    observed_user_message_count: evidence.observedUserMessageCount,
    assistant_message_count: evidence.assistantMessageCount ?? null,
    count_regression_detected: evidence.countRegressionDetected ?? false,
    request_message_found: evidence.requestMessageFound,
    request_message_found_by: evidence.requestMessageFoundBy ?? null,
    request_message_scan_complete: evidence.requestMessageScanComplete ?? false,
    is_answering: evidence.isAnswering,
    last_message_role: evidence.lastMessageRole ?? null,
    composer_prompt_state: evidence.composerPromptState ?? null,
    composer_attachment_count: evidence.composerAttachmentCount ?? null,
    composer_pasted_text_attachment_present:
      evidence.composerPastedTextAttachmentPresent ?? false,
    composer_send_button_enabled: evidence.composerSendButtonEnabled ?? null,
    delivery_failure: evidence.deliveryFailure ?? null,
  });
}
