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

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new CueLineError("RUN_CANCELLED", "Run cancelled.");
  }
}

async function readUrlBeforeDeadline(
  tab: IabTab,
  deadline: number,
  signal?: AbortSignal,
): Promise<string> {
  assertNotAborted(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = (): void => {};
  const interrupted = new Promise<string>((resolve, reject) => {
    timer = setTimeout(() => resolve(""), Math.max(0, deadline - Date.now()));
    onAbort = (): void => {
      reject(signal?.reason ?? new CueLineError("RUN_CANCELLED", "Run cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    // Keep a rejection handler attached even if the read settles after timeout.
    const url = await Promise.race([
      interrupted,
      Promise.resolve().then(() => tab.url()).catch(() => ""),
    ]);
    assertNotAborted(signal);
    return url ?? "";
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason ?? new CueLineError("RUN_CANCELLED", "Run cancelled."));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
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
    const currentUrl = await readUrlBeforeDeadline(tab, deadline, signal);
    if (Date.now() >= deadline) break;
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
    await wait(Math.max(0, Math.min(pollIntervalMs, 100, deadline - Date.now())), signal);
  } while (Date.now() < deadline);
  throw new CueLineError(
    "CONTROLLER_CONVERSATION_URL_UNAVAILABLE",
    "ChatGPT accepted the single send click but did not expose an exact conversation URL in time. Refusing to return an unrecoverable controller wait or click again.",
  );
}
