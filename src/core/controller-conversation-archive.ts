import { isExactChatGptConversationUrl, sameChatGptConversationUrl } from "./conversation-url.js";
import type { ControllerRuntimeOptions } from "./controller-types.js";
import { asCueLineError, CueLineError } from "./errors.js";
import type { CueLineRunState } from "./state-machine.js";
import type { RunStore } from "../state/store.js";

const MAX_ARCHIVE_FAILURE_CHARS = 2_000;

function archiveStatus(store: RunStore<CueLineRunState>) {
  return store.state.controllerConversationArchive.status;
}

function boundedMessage(message: string): string {
  return message.length <= MAX_ARCHIVE_FAILURE_CHARS
    ? message
    : `${message.slice(0, MAX_ARCHIVE_FAILURE_CHARS)}…`;
}

export function controllerConversationArchiveNeedsRecovery(
  state: CueLineRunState,
): boolean {
  const archive = state.controllerConversationArchive;
  return (
    state.status === "complete" &&
    archive?.enabled === true &&
    (archive.status === "pending" || archive.status === "started")
  );
}

async function recordDeterministicFailure(
  store: RunStore<CueLineRunState>,
  error: CueLineError,
): Promise<void> {
  await store.append("controller_conversation_archive_failed", {
    code: error.code,
    message: boundedMessage(error.message),
  });
  await store.snapshot();
}

async function recordAmbiguousFailure(
  store: RunStore<CueLineRunState>,
  error: unknown,
): Promise<void> {
  const failure = asCueLineError(error, "CONTROLLER_CONVERSATION_ARCHIVE_AMBIGUOUS");
  await store.append("controller_conversation_archive_ambiguous", {
    code: failure.code,
    message: boundedMessage(failure.message),
  });
  await store.snapshot();
}

async function recordRetryablePreflightFailure(
  store: RunStore<CueLineRunState>,
  error: unknown,
): Promise<void> {
  const failure = asCueLineError(error, "CONTROLLER_CONVERSATION_ARCHIVE_PREFLIGHT_FAILED");
  await store.append("controller_conversation_archive_preflight_failed", {
    code: failure.code,
    message: boundedMessage(failure.message),
  });
  await store.snapshot();
}

/**
 * Settle the optional post-completion archive exactly once. A durable
 * `started` event is written by the browser's write-ahead hook immediately
 * before the one Archive click. Failures before that checkpoint remain safely
 * retryable; a restarted process after it must become ambiguous without a click.
 */
export async function settleControllerConversationArchive(
  store: RunStore<CueLineRunState>,
  options: Pick<ControllerRuntimeOptions, "browser" | "signal">,
): Promise<void> {
  if (!controllerConversationArchiveNeedsRecovery(store.state)) return;

  if (store.state.controllerConversationArchive.status === "started") {
    await recordAmbiguousFailure(
      store,
      new CueLineError(
        "CONTROLLER_CONVERSATION_ARCHIVE_INTERRUPTED",
        "A previous archive attempt started without durable completion proof. Refusing another archive click.",
      ),
    );
    return;
  }

  const conversationUrl = store.state.conversationUrl;
  if (!isExactChatGptConversationUrl(conversationUrl)) {
    await recordDeterministicFailure(
      store,
      new CueLineError(
        "CONTROLLER_CONVERSATION_ARCHIVE_URL_REQUIRED",
        "The completed run has no exact ChatGPT conversation URL to archive.",
      ),
    );
    return;
  }
  if (options.browser.archiveConversation === undefined) {
    await recordDeterministicFailure(
      store,
      new CueLineError(
        "CONTROLLER_CONVERSATION_ARCHIVE_UNSUPPORTED",
        "The selected browser adapter does not support controller conversation archiving.",
      ),
    );
    return;
  }

  try {
    const evidence = await options.browser.archiveConversation(
      {
        conversationUrl,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      {
        async onBeforeArchiveClick() {
          if (store.state.controllerConversationArchive.status !== "pending") {
            throw new CueLineError(
              "CONTROLLER_CONVERSATION_ARCHIVE_CHECKPOINT_INVALID",
              "The archive click checkpoint is no longer pending.",
            );
          }
          await store.append("controller_conversation_archive_started", {
            conversation_url: conversationUrl,
          });
          await store.snapshot();
        },
      },
    );
    if (archiveStatus(store) !== "started") {
      await store.append("controller_conversation_archive_started", {
        conversation_url: conversationUrl,
      });
      await store.snapshot();
      await recordAmbiguousFailure(
        store,
        new CueLineError(
          "CONTROLLER_CONVERSATION_ARCHIVE_CHECKPOINT_MISSING",
          "The browser returned archive evidence without the required pre-click checkpoint. Refusing another archive attempt.",
        ),
      );
      return;
    }
    if (
      !sameChatGptConversationUrl(evidence.conversationUrl, conversationUrl) ||
      evidence.proof !== "conversation_url_changed" ||
      typeof evidence.postActionUrl !== "string" ||
      !evidence.postActionUrl.startsWith("https://chatgpt.com/") ||
      sameChatGptConversationUrl(evidence.postActionUrl, conversationUrl)
    ) {
      throw new CueLineError(
        "CONTROLLER_CONVERSATION_ARCHIVE_EVIDENCE_INVALID",
        "The browser returned invalid or non-terminal archive evidence.",
      );
    }
    await store.append("controller_conversation_archived", {
      conversation_url: conversationUrl,
      proof: evidence.proof,
      post_action_url: evidence.postActionUrl,
    });
    await store.snapshot();
  } catch (error) {
    if (archiveStatus(store) === "started") {
      await recordAmbiguousFailure(store, error);
    } else {
      await recordRetryablePreflightFailure(store, error);
    }
  }
}
