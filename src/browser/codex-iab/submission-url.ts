import { CueLineError } from "../../core/errors.js";
import {
  isExactChatGptConversationUrl,
  sameChatGptConversationUrl,
} from "../../core/conversation-url.js";
import type { IabTab } from "./bootstrap.js";

// ChatGPT can spend several seconds converting a large composer payload into
// an attachment before the new `/c/...` route becomes visible. Keep this below
// the common 30-second outer tool window while leaving enough time for that
// real transition.
const CAPTURE_TIMEOUT_MS = 15_000;

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason ?? new CueLineError("RUN_CANCELLED", "Run cancelled."));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new CueLineError("RUN_CANCELLED", "Run cancelled."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function captureConversationUrlAfterSubmit(
  tab: IabTab,
  knownUrl: string | undefined,
  timeoutMs: number,
  pollIntervalMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const expectedUrl =
    knownUrl !== undefined && isExactChatGptConversationUrl(knownUrl)
      ? knownUrl
      : undefined;
  const deadline = Date.now() + Math.min(timeoutMs, CAPTURE_TIMEOUT_MS);
  do {
    const currentUrl = (await tab.url().catch(() => "")) ?? "";
    if (isExactChatGptConversationUrl(currentUrl)) {
      if (
        expectedUrl !== undefined &&
        !sameChatGptConversationUrl(currentUrl, expectedUrl)
      ) {
        throw new CueLineError(
          "CONTROLLER_RECONCILIATION_CONVERSATION_MISMATCH",
          "ChatGPT navigated to a different conversation after the single send click. Refusing to bind either conversation or click again.",
          {
            details: {
              expected_conversation_url: expectedUrl,
              observed_conversation_url: currentUrl,
            },
          },
        );
      }
      return expectedUrl ?? currentUrl;
    }
    await wait(Math.min(pollIntervalMs, 100), signal);
  } while (Date.now() < deadline);
  throw new CueLineError(
    "CONTROLLER_CONVERSATION_URL_UNAVAILABLE",
    "ChatGPT accepted the single send click but did not expose an exact conversation URL in time. Refusing to return an unrecoverable controller wait or click again.",
  );
}
