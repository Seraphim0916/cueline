import type {
  BrowserAdapter,
  BrowserConversationArchiveEvidence,
  BrowserConversationArchiveHooks,
  BrowserConversationArchiveInput,
  BrowserSubmittedTurnEvidence,
  BrowserSubmittedTurnObservation,
  BrowserTurnHooks,
  BrowserTurnInput,
  ComposerPromptState,
  ControllerModelEvidence,
  ControllerTurn,
} from "../browser-adapter.js";
import {
  isExactChatGptConversationUrl as isConversationUrl,
  sameChatGptConversationUrl,
} from "../../core/conversation-url.js";
import { CueLineError } from "../../core/errors.js";
import { commandHash } from "../../core/ids.js";
import {
  readPageChatState,
  readPageComposerState,
  resolveIabBrowser,
  type IabBrowser,
  type IabLocator,
  type IabTab,
  type PageChatState,
} from "./bootstrap.js";
import {
  ARCHIVE_MENUITEM_NAMES,
  CHATGPT_URL,
  COMPOSER_TEXTBOX_NAMES,
  SEND_BUTTON_NAMES,
} from "./selectors.js";
import {
  hasExactControllerEnvelopeIdentity,
  isProLabel,
  isProModelSlug,
  normalizedMessageText,
} from "./recovery-evidence.js";
import { captureConversationUrlAfterSubmit } from "./submission-url.js";
import { findVisibleSendButtonCoordinates } from "./send-button.js";
import { acquireChatGptTab, isTabUnavailableError } from "./tab-discovery.js";
import { validatedTimingOption } from "./timing-options.js";
import type { ExpectedControllerIdentity } from "../../protocol/types.js";

export interface CodexIabAdapterOptions {
  browser?: IabBrowser;
  conversationUrl?: string;
  /** Positive integer no greater than Node's maximum timer delay. */
  timeoutMs?: number;
  /** Positive integer no greater than Node's maximum timer delay. */
  pollIntervalMs?: number;
  /** Non-negative integer no greater than Node's maximum timer delay. */
  stableMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_STABLE_MS = 1_500;
const COMPOSER_HYDRATION_TIMEOUT_MS = 5_000;
const SUBMITTED_RECOVERY_HYDRATION_TIMEOUT_MS = 10_000;
const CONTENTEDITABLE_COMPOSER_SELECTOR = '#prompt-textarea[contenteditable="true"]';
const MODEL_PICKER_SELECTOR = "button.__composer-pill";
const REQUIRED_MODEL_LABEL = "Pro";
const MODEL_LABEL_READ_ATTEMPTS = 50;
const MODEL_LABEL_RETRY_INTERVAL_MS = 100;
const COMPOSER_READY_TIMEOUT_MS = 30_000;
const COMPOSER_READY_STABLE_MS = 250;
const SUBMISSION_ACTION_TIMEOUT_MS = 10_000;
const POST_CLICK_ACKNOWLEDGEMENT_TIMEOUT_MS = 10_000;
const CONVERSATION_OPTIONS_SELECTOR = '[data-testid="conversation-options-button"]';
const ARCHIVE_PROOF_TIMEOUT_MS = 10_000;
type TurnStage = "pre_submit" | "submitting" | "submitted";

interface TurnAttemptContext {
  stage: TurnStage;
  baseline?: PageChatState;
  selectedModelLabel?: string;
  composerPromptState?: ComposerPromptState;
}

type SendTarget =
  | { kind: "locator"; locator: IabLocator }
  | { kind: "coordinate"; x: number; y: number };

type PostClickAcknowledgement =
  | { status: "submitted"; state: PageChatState }
  | { status: "definitely_not_sent"; state: PageChatState }
  | { status: "possibly_sent"; state: PageChatState };

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof CueLineError) throw signal.reason;
  throw new CueLineError("RUN_CANCELLED", "CueLine run cancellation was requested.", {
    cause: signal.reason,
  });
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfCancelled(signal);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      try {
        throwIfCancelled(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function withBrowserOperationTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  timeoutError: () => CueLineError,
): Promise<T> {
  throwIfCancelled(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = (): void => {
      settle(() => {
        try {
          throwIfCancelled(signal);
        } catch (error) {
          reject(error);
        }
      });
    };
    const timer = setTimeout(() => {
      settle(() => reject(timeoutError()));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(operation)
      .then(
        (value) => settle(() => resolve(value)),
        (error: unknown) => settle(() => reject(error)),
      );
  });
}

async function findUniqueLocator(
  tab: IabTab,
  role: string,
  names: readonly string[],
): Promise<IabLocator | undefined> {
  for (const name of names) {
    const locator = tab.playwright.getByRole(role, { name });
    if ((await locator.count()) === 1) {
      return locator;
    }
  }
  return undefined;
}

async function isActionableLocator(locator: IabLocator): Promise<boolean> {
  if ((await locator.count()) !== 1) return false;
  if (locator.isVisible && !(await locator.isVisible())) return false;
  if (locator.isEnabled && !(await locator.isEnabled())) return false;
  return true;
}

async function findHydratedComposer(tab: IabTab): Promise<IabLocator | undefined> {
  if (!tab.playwright.locator) return undefined;
  const composer = tab.playwright.locator(CONTENTEDITABLE_COMPOSER_SELECTOR);
  try {
    await composer.waitFor?.({ state: "visible", timeoutMs: COMPOSER_HYDRATION_TIMEOUT_MS });
    return (await composer.count()) === 1 ? composer : undefined;
  } catch {
    return undefined;
  }
}

function ambiguousSubmissionError(error: unknown): CueLineError {
  return new CueLineError(
    "CONTROLLER_SUBMISSION_AMBIGUOUS",
    "The send-button click failed without proving whether ChatGPT accepted the prompt. Refusing a second click; reconcile the exact conversation instead.",
    { cause: error },
  );
}

function submissionStateForStage(
  stage: TurnStage,
): "definitely_not_sent" | "possibly_sent" | "submitted" {
  if (stage === "pre_submit") return "definitely_not_sent";
  return stage === "submitting" ? "possibly_sent" : "submitted";
}

async function readComposerModelLabel(tab: IabTab): Promise<string | null> {
  return tab.playwright.evaluate(
    ({ modelPickerSelector }) => {
      const knownModel = /^(?:Instant(?:\s+\d+(?:\.\d+)*)?|Medium|High|Extra High|Thinking|Auto|Pro(?:\s+(?:Standard|Extended))?)$/i;
      const labels = Array.from(document.querySelectorAll(modelPickerSelector))
        .filter((element) => {
          if ((element as HTMLElement).hidden) return false;
          if (element.getAttribute("aria-hidden") === "true") return false;
          const style = window.getComputedStyle(element);
          return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
        })
        .map((element) =>
          String(
            element.getAttribute("aria-label") ??
              (element as HTMLElement).innerText ??
              element.textContent ??
              "",
          ),
        )
        .map((label) => label.replace(/\s+/g, " ").trim())
        .filter((label) => knownModel.test(label));
      return labels.length === 1 ? labels[0]! : null;
    },
    { modelPickerSelector: MODEL_PICKER_SELECTOR },
  );
}

async function readComposerModelLabelWhenReady(
  tab: IabTab,
  signal?: AbortSignal,
): Promise<string | null> {
  for (let attempt = 0; attempt < MODEL_LABEL_READ_ATTEMPTS; attempt += 1) {
    throwIfCancelled(signal);
    const label = await readComposerModelLabel(tab);
    if (label !== null) return label;
    if (attempt < MODEL_LABEL_READ_ATTEMPTS - 1) {
      await tab.playwright.waitForTimeout(MODEL_LABEL_RETRY_INTERVAL_MS);
    }
  }
  return null;
}

class CodexIabAdapter implements BrowserAdapter {
  readonly submissionCheckpointContract = "write_ahead_v1" as const;
  readonly #options: Required<Pick<CodexIabAdapterOptions, "timeoutMs" | "pollIntervalMs" | "stableMs">> &
    Pick<CodexIabAdapterOptions, "browser" | "conversationUrl">;
  #browser: IabBrowser | undefined;
  #tab: IabTab | undefined;
  #conversationUrl: string | undefined;

  constructor(options: CodexIabAdapterOptions) {
    if (
      options.conversationUrl !== undefined &&
      !isConversationUrl(options.conversationUrl)
    ) {
      throw new CueLineError(
        "CONTROLLER_RECONCILIATION_URL_REQUIRED",
        "CueLine requires an exact ChatGPT /c/<conversation-id> URL for an existing controller conversation.",
      );
    }
    this.#options = {
      timeoutMs: validatedTimingOption(
        "timeoutMs",
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        1,
        "IAB_TIMEOUT_INVALID",
      ),
      pollIntervalMs: validatedTimingOption(
        "pollIntervalMs",
        options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
        1,
        "IAB_POLL_INTERVAL_INVALID",
      ),
      stableMs: validatedTimingOption(
        "stableMs",
        options.stableMs ?? DEFAULT_STABLE_MS,
        0,
        "IAB_STABLE_WINDOW_INVALID",
      ),
      ...(options.browser === undefined ? {} : { browser: options.browser }),
      ...(options.conversationUrl === undefined ? {} : { conversationUrl: options.conversationUrl }),
    };
    this.#conversationUrl = options.conversationUrl;
  }

  async #getBrowser(): Promise<IabBrowser> {
    this.#browser ??= await resolveIabBrowser(this.#options.browser);
    return this.#browser;
  }

  async #getTab(): Promise<IabTab> {
    if (this.#tab) {
      try {
        const cachedUrl = (await this.#tab.url()) ?? "";
        const expected = this.#conversationUrl;
        if (
          cachedUrl.startsWith(CHATGPT_URL) &&
          (expected === undefined ||
            sameChatGptConversationUrl(cachedUrl, expected))
        ) {
          return this.#tab;
        }
      } catch (error) {
        if (!isTabUnavailableError(error)) throw error;
      }
      this.#tab = undefined;
    }
    const browser = await this.#getBrowser();
    this.#tab = await acquireChatGptTab(browser, this.#conversationUrl);
    return this.#tab;
  }

  async #ensureProModel(tab: IabTab, signal?: AbortSignal): Promise<string> {
    let label = await readComposerModelLabelWhenReady(tab, signal);
    if (isProLabel(label)) return label;
    if (label === null) {
      throw new CueLineError(
        "MODEL_SELECTOR_MISSING",
        "Could not identify ChatGPT's composer model selector. Refusing to send without Pro evidence.",
      );
    }
    if (!tab.playwright.locator) {
      throw new CueLineError(
        "PRO_MODEL_UNAVAILABLE",
        `ChatGPT is using '${label}', and the Pro model picker is unavailable.`,
      );
    }
    const picker = tab.playwright.locator(MODEL_PICKER_SELECTOR);
    if ((await picker.count()) !== 1) {
      throw new CueLineError(
        "PRO_MODEL_UNAVAILABLE",
        `ChatGPT is using '${label}', and CueLine could not uniquely locate the model picker.`,
      );
    }
    await picker.click({ timeoutMs: 10_000 });
    const proOption = await findUniqueLocator(tab, "menuitemradio", [REQUIRED_MODEL_LABEL]);
    if (!proOption) {
      throw new CueLineError(
        "PRO_MODEL_UNAVAILABLE",
        `ChatGPT is using '${label}', and the Pro model option is unavailable.`,
      );
    }
    await proOption.click({ timeoutMs: 10_000 });
    await tab.playwright.waitForTimeout(250);
    label = await readComposerModelLabel(tab);
    if (!isProLabel(label)) {
      throw new CueLineError(
        "PRO_MODEL_SELECTION_FAILED",
        `ChatGPT did not switch to Pro; current composer model is '${label ?? "unknown"}'.`,
      );
    }
    return label;
  }

  async #submissionStarted(
    tab: IabTab,
    previousUrl: string,
    baseline: PageChatState,
    observedState?: PageChatState,
  ): Promise<boolean> {
    const currentUrl = (await tab.url().catch(() => previousUrl)) ?? previousUrl;
    if (!isConversationUrl(previousUrl) && isConversationUrl(currentUrl)) {
      return true;
    }
    const state =
      observedState ??
      (await readPageChatState(tab).catch(() => ({
        pageUrl: "",
        isAnswering: false,
        assistantText: "",
        userMessageCount: 0,
        assistantMessageCount: 0,
        assistantModelSlug: null,
        lastUserText: null,
        lastMessageRole: null,
      })));
    if (
      isConversationUrl(previousUrl) &&
      !sameChatGptConversationUrl(state.pageUrl, previousUrl)
    ) {
      return false;
    }
    return (
      state.isAnswering ||
      (state.userMessageCount ?? 0) > (baseline.userMessageCount ?? 0) ||
      state.assistantMessageCount > baseline.assistantMessageCount
    );
  }

  async #waitForPostClickAcknowledgement(
    tab: IabTab,
    input: BrowserTurnInput,
    context: TurnAttemptContext,
    capturedConversationUrl?: string,
  ): Promise<PostClickAcknowledgement> {
    const baseline = context.baseline!;
    const deadline =
      Date.now() +
      Math.min(this.#options.timeoutMs, POST_CLICK_ACKNOWLEDGEMENT_TIMEOUT_MS);
    const operationTimeoutMs = Math.min(
      SUBMISSION_ACTION_TIMEOUT_MS,
      this.#options.timeoutMs,
    );
    let stableSignature = "";
    let stableSince = 0;
    const normalizedPrompt = normalizedMessageText(input.prompt);

    for (;;) {
      throwIfCancelled(input.signal);
      const state = await withBrowserOperationTimeout(
        () => readPageChatState(tab),
        operationTimeoutMs,
        input.signal,
        () =>
          new CueLineError(
            "CONTROLLER_SUBMISSION_POSTCLICK_READ_TIMEOUT",
            `ChatGPT's post-click state check did not finish within ${operationTimeoutMs} ms.`,
          ),
      );
      const composerState = await withBrowserOperationTimeout(
        () => readPageComposerState(tab, input.prompt, SEND_BUTTON_NAMES),
        operationTimeoutMs,
        input.signal,
        () =>
          new CueLineError(
            "CONTROLLER_SUBMISSION_POSTCLICK_READ_TIMEOUT",
            `ChatGPT's post-click composer check did not finish within ${operationTimeoutMs} ms.`,
          ),
      );
      if (
        isConversationUrl(baseline.pageUrl) &&
        !sameChatGptConversationUrl(state.pageUrl, baseline.pageUrl)
      ) {
        throw new CueLineError(
          "CONTROLLER_RECONCILIATION_CONVERSATION_MISMATCH",
          "ChatGPT navigated to a different conversation after the single send click. Refusing to bind either conversation or click again.",
        );
      }

      const observedUserMessageCount = state.userMessageCount ?? 0;
      const baselineUserMessageCount = baseline.userMessageCount ?? 0;
      const requestMessageFound =
        state.lastUserText !== null &&
        (normalizedMessageText(state.lastUserText) ===
          normalizedPrompt ||
          state.lastUserText.includes(input.requestId));
      const stagedPromptRemains =
        context.composerPromptState === "attachment_ready"
          ? composerState.state === "attachment_ready" &&
            composerState.attachmentCount > 0 &&
            composerState.sendButtonEnabled
          : composerState.state === "inline_ready" && composerState.sendButtonEnabled;
      const createdConversation =
        !isConversationUrl(baseline.pageUrl) &&
        capturedConversationUrl !== undefined &&
        isConversationUrl(capturedConversationUrl);
      const userTurnAdded = observedUserMessageCount > baselineUserMessageCount;
      const answeringStarted = !baseline.isAnswering && state.isAnswering;
      const assistantTurnAdded =
        state.assistantMessageCount > baseline.assistantMessageCount;

      if (
        requestMessageFound ||
        createdConversation ||
        userTurnAdded ||
        answeringStarted ||
        assistantTurnAdded
      ) {
        return { status: "submitted", state };
      }
      if (!stagedPromptRemains) {
        return { status: "possibly_sent", state };
      }

      const now = Date.now();
      const definitelyNotSentCandidate =
        observedUserMessageCount === baselineUserMessageCount &&
        state.assistantMessageCount === baseline.assistantMessageCount &&
        !requestMessageFound &&
        !state.isAnswering;
      if (definitelyNotSentCandidate) {
        const signature = `${observedUserMessageCount}:${state.assistantMessageCount}:${state.lastMessageRole}:${state.lastUserText ?? ""}:${composerState.state}:${composerState.attachmentCount}:${composerState.sendButtonEnabled}`;
        if (signature !== stableSignature) {
          stableSignature = signature;
          stableSince = now;
        }
        if (now - stableSince >= this.#options.stableMs) {
          return { status: "definitely_not_sent", state };
        }
      } else {
        stableSignature = "";
        stableSince = 0;
      }
      if (now >= deadline) return { status: "possibly_sent", state };
      await delay(
        Math.min(this.#options.pollIntervalMs, Math.max(1, deadline - now)),
        input.signal,
      );
    }
  }

  async #resolveSendTarget(tab: IabTab): Promise<SendTarget> {
    const locator = await findUniqueLocator(tab, "button", SEND_BUTTON_NAMES);
    if (locator) return { kind: "locator", locator };
    const coordinate = await findVisibleSendButtonCoordinates(tab);
    if (coordinate) return { kind: "coordinate", ...coordinate };
    throw new CueLineError(
      "SEND_BUTTON_MISSING",
      "Could not find ChatGPT's send button.",
    );
  }

  async #clickSend(
    tab: IabTab,
    target: SendTarget,
    baseline: PageChatState,
    input: BrowserTurnInput,
    context: TurnAttemptContext,
    hooks?: BrowserTurnHooks,
  ): Promise<void> {
    const operationTimeoutMs = Math.min(
      SUBMISSION_ACTION_TIMEOUT_MS,
      this.#options.timeoutMs,
    );
    const previousUrl =
      (await withBrowserOperationTimeout(
        () => tab.url(),
        operationTimeoutMs,
        input.signal,
        () =>
          new CueLineError(
            "CONTROLLER_SUBMISSION_PRECLICK_TIMEOUT",
            `ChatGPT's pre-click URL check did not finish within ${operationTimeoutMs} ms; no send click was attempted.`,
          ),
      )) ?? "";
    context.stage = "submitting";
    try {
      if (target.kind === "locator") {
        await withBrowserOperationTimeout(
          () => target.locator.click({ timeoutMs: operationTimeoutMs }),
          operationTimeoutMs,
          input.signal,
          () =>
            new CueLineError(
              "CONTROLLER_SUBMISSION_CLICK_TIMEOUT",
              `ChatGPT's send click did not finish within ${operationTimeoutMs} ms.`,
            ),
        );
      } else {
        await withBrowserOperationTimeout(
          () => tab.cua!.click({ x: target.x, y: target.y }),
          operationTimeoutMs,
          input.signal,
          () =>
            new CueLineError(
              "CONTROLLER_SUBMISSION_CLICK_TIMEOUT",
              `ChatGPT's coordinate send click did not finish within ${operationTimeoutMs} ms.`,
            ),
        );
        await tab.playwright.waitForTimeout(100);
      }
    } catch (error) {
      const observed = await withBrowserOperationTimeout(
        () => readPageChatState(tab),
        operationTimeoutMs,
        input.signal,
        () =>
          new CueLineError(
            "CONTROLLER_SUBMISSION_POSTCLICK_READ_TIMEOUT",
            `ChatGPT's post-click state check did not finish within ${operationTimeoutMs} ms.`,
          ),
      ).catch(() => undefined);
      await this.#emitCheckpoint(
        input,
        tab,
        context,
        hooks,
        "possibly_sent",
        "error",
        observed?.pageUrl,
        observed ?? null,
        error,
      );
      if (observed === undefined) {
        if (isTabUnavailableError(error)) throw error;
        throw ambiguousSubmissionError(error);
      }
      if (await this.#submissionStarted(tab, previousUrl, baseline, observed)) return;
      if (isTabUnavailableError(error)) throw error;
      throw ambiguousSubmissionError(error);
    }
  }

  async #waitForCompletion(
    tab: IabTab,
    baseline: PageChatState,
    notSentRecovery?: BrowserTurnInput["notSentRecovery"],
    signal?: AbortSignal,
  ): Promise<PageChatState> {
    const deadline = Date.now() + this.#options.timeoutMs;
    let stableText = "";
    let stableSince = 0;
    let responseStarted = false;
    while (Date.now() < deadline) {
      throwIfCancelled(signal);
      const state = await readPageChatState(tab);
      if (
        notSentRecovery !== undefined &&
        (state.userMessageCount ?? 0) > (baseline.userMessageCount ?? 0) + 1
      ) {
        throw new CueLineError(
          "CONTROLLER_NOT_SENT_CONFIRMATION_CONFLICT",
          "The abandoned controller message appeared after the operator-confirmed retry began; freezing the run.",
          {
            details: {
              stage: "observing_retry",
              submission_state: "possibly_sent",
              abandoned_request_id: notSentRecovery.abandonedRequestId,
              baseline_user_message_count:
                notSentRecovery.baselineUserMessageCount,
              observed_user_message_count: state.userMessageCount ?? 0,
            },
          },
        );
      }
      if (state.isAnswering || state.assistantMessageCount > baseline.assistantMessageCount) {
        responseStarted = true;
      }
      if (responseStarted && !state.isAnswering && state.assistantText !== "") {
        if (state.assistantText !== stableText) {
          stableText = state.assistantText;
          stableSince = Date.now();
        }
        if (Date.now() - stableSince >= this.#options.stableMs) {
          return state;
        }
      } else {
        stableText = state.assistantText;
        stableSince = Date.now();
      }
      await delay(this.#options.pollIntervalMs, signal);
    }
    throw new CueLineError("CHATGPT_RESPONSE_TIMEOUT", "ChatGPT did not finish before timeout.");
  }

  async #waitForRecoveredCompletion(
    tab: IabTab,
    expectedPrompt: string,
    allowVisiblePromptMismatch: boolean,
    manualSendConfirmed: boolean,
    baselineAssistantMessageCount: number | undefined,
    expectedConversationUrl: string,
    expectedIdentity: ExpectedControllerIdentity,
    signal?: AbortSignal,
  ): Promise<PageChatState> {
    const attachmentBaseline = allowVisiblePromptMismatch
      ? baselineAssistantMessageCount
      : undefined;
    if (
      allowVisiblePromptMismatch &&
      attachmentBaseline === undefined &&
      !manualSendConfirmed
    ) {
      throw new CueLineError(
        "CONTROLLER_RECONCILIATION_BASELINE_REQUIRED",
        "Attachment recovery requires the durable pre-submit assistant message count; refusing to import a possibly stale response.",
      );
    }
    const deadline = Date.now() + this.#options.timeoutMs;
    let stableText = "";
    let stableSince = 0;
    while (Date.now() < deadline) {
      throwIfCancelled(signal);
      const state = await this.#readRecoveredCandidate(
        tab,
        expectedPrompt,
        allowVisiblePromptMismatch,
        manualSendConfirmed,
        attachmentBaseline,
        expectedConversationUrl,
        expectedIdentity,
      );
      if (state !== undefined) {
        if (state.assistantText !== stableText) {
          stableText = state.assistantText;
          stableSince = Date.now();
        }
        if (Date.now() - stableSince >= this.#options.stableMs) return state;
      } else {
        stableText = "";
        stableSince = Date.now();
      }
      await delay(this.#options.pollIntervalMs, signal);
    }
    throw new CueLineError(
      "CONTROLLER_RECONCILIATION_TIMEOUT",
      "The existing ChatGPT response did not become readable before timeout; no prompt was sent.",
    );
  }

  async #readRecoveredCandidate(
    tab: IabTab,
    expectedPrompt: string,
    allowVisiblePromptMismatch: boolean,
    manualSendConfirmed: boolean,
    attachmentBaseline: number | undefined,
    expectedConversationUrl: string,
    expectedIdentity: ExpectedControllerIdentity,
  ): Promise<PageChatState | undefined> {
    const state = await readPageChatState(tab);
    if (!sameChatGptConversationUrl(state.pageUrl, expectedConversationUrl)) {
      throw new CueLineError(
        "CONTROLLER_RECONCILIATION_CONVERSATION_MISMATCH",
        "The response evidence was read from a different ChatGPT conversation DOM.",
      );
    }
    const hasExactEnvelope = hasExactControllerEnvelopeIdentity(
      state.assistantText,
      expectedIdentity,
    );
    if (
      attachmentBaseline !== undefined &&
      state.assistantMessageCount <= attachmentBaseline &&
      !hasExactEnvelope
    ) return undefined;
    if (
      manualSendConfirmed &&
      attachmentBaseline === undefined &&
      !hasExactEnvelope
    ) return undefined;
    if (state.lastUserText === null && !manualSendConfirmed) return undefined;
    if (
      !allowVisiblePromptMismatch &&
      normalizedMessageText(state.lastUserText) !== normalizedMessageText(expectedPrompt)
    ) {
      throw new CueLineError(
        "CONTROLLER_RECONCILIATION_MISMATCH",
        "The exact conversation's last user message does not match the pending CueLine prompt. Refusing to import an unrelated response.",
      );
    }
    return !state.isAnswering &&
      state.lastMessageRole === "assistant" &&
      state.assistantText !== ""
      ? state
      : undefined;
  }

  async #observeRecoveredCompletion(
    tab: IabTab,
    expectedPrompt: string,
    allowVisiblePromptMismatch: boolean,
    manualSendConfirmed: boolean,
    baselineAssistantMessageCount: number | undefined,
    expectedConversationUrl: string,
    expectedIdentity: ExpectedControllerIdentity,
    signal?: AbortSignal,
  ): Promise<PageChatState | undefined> {
    if (
      allowVisiblePromptMismatch &&
      baselineAssistantMessageCount === undefined &&
      !manualSendConfirmed
    ) {
      throw new CueLineError(
        "CONTROLLER_RECONCILIATION_BASELINE_REQUIRED",
        "Attachment recovery requires the durable pre-submit assistant message count; refusing to import a possibly stale response.",
      );
    }
    throwIfCancelled(signal);
    const first = await this.#readRecoveredCandidate(
      tab,
      expectedPrompt,
      allowVisiblePromptMismatch,
      manualSendConfirmed,
      allowVisiblePromptMismatch ? baselineAssistantMessageCount : undefined,
      expectedConversationUrl,
      expectedIdentity,
    );
    if (first === undefined) return undefined;
    if (this.#options.stableMs > 0) await delay(this.#options.stableMs, signal);
    const second = await this.#readRecoveredCandidate(
      tab,
      expectedPrompt,
      allowVisiblePromptMismatch,
      manualSendConfirmed,
      allowVisiblePromptMismatch ? baselineAssistantMessageCount : undefined,
      expectedConversationUrl,
      expectedIdentity,
    );
    return second !== undefined &&
      second.assistantText === first.assistantText &&
      second.assistantMessageCount === first.assistantMessageCount &&
      second.assistantModelSlug === first.assistantModelSlug
      ? second
      : undefined;
  }

  async #waitForComposerReady(
    tab: IabTab,
    expectedPrompt: string,
    baselineAttachmentCount: number,
    signal?: AbortSignal,
  ): Promise<ComposerPromptState> {
    const deadline = Date.now() + Math.min(COMPOSER_READY_TIMEOUT_MS, this.#options.timeoutMs);
    const stableRequirement = Math.min(COMPOSER_READY_STABLE_MS, this.#options.stableMs);
    let stableSignature = "";
    let stableSince = 0;
    let lastState = await readPageComposerState(tab, expectedPrompt, SEND_BUTTON_NAMES);
    while (Date.now() < deadline) {
      throwIfCancelled(signal);
      const state = await readPageComposerState(tab, expectedPrompt, SEND_BUTTON_NAMES);
      lastState = state;
      const ready =
        state.sendButtonEnabled &&
        (state.state === "inline_ready" ||
          (state.state === "attachment_ready" &&
            state.attachmentCount > baselineAttachmentCount));
      const signature = `${state.state}:${state.inlineTextLength}:${state.attachmentCount}:${state.sendButtonEnabled}`;
      if (ready) {
        if (signature !== stableSignature) {
          stableSignature = signature;
          stableSince = Date.now();
        }
        if (Date.now() - stableSince >= stableRequirement && ready) {
          return state.state === "inline_ready" ? "inline_ready" : "attachment_ready";
        }
      } else {
        stableSignature = "";
        stableSince = 0;
      }
      await delay(Math.min(this.#options.pollIntervalMs, 100), signal);
    }
    throw new CueLineError(
      "CONTROLLER_PROMPT_NOT_READY",
      "ChatGPT exposed neither the exact inline prompt nor an attachment with an enabled send button after the composer settled.",
      { details: { composer_state: lastState.state, attachment_count: lastState.attachmentCount } },
    );
  }

  async #resultFromCompletedTurn(
    tab: IabTab,
    selectedModelLabel: string,
    completed: PageChatState,
  ): Promise<ControllerTurn> {
    if (!isProModelSlug(completed.assistantModelSlug)) {
      throw new CueLineError(
        "PRO_MODEL_MISMATCH",
        `ChatGPT returned model '${completed.assistantModelSlug ?? "unknown"}' after Pro was selected. Refusing the controller response.`,
        {
          details: {
            selected_model_label: selectedModelLabel,
            response_model_slug: completed.assistantModelSlug,
          },
        },
      );
    }
    // Bind response text and URL from one DOM evaluation. A later CDP URL
    // read can observe navigation to another conversation and must never be
    // paired with this completed assistant message.
    const conversationUrl = completed.pageUrl;
    if (isConversationUrl(conversationUrl)) this.#conversationUrl = conversationUrl;
    const title = await tab.title?.();
    const model: ControllerModelEvidence = {
      provider: "chatgpt",
      selectedLabel: selectedModelLabel,
      responseModelSlug: completed.assistantModelSlug,
      source: "composer_and_response",
    };
    return {
      text: completed.assistantText,
      model,
      ...(conversationUrl === "" ? {} : { conversationUrl }),
      ...(title === undefined || title === "" ? {} : { title }),
    };
  }

  async #submitTurnOnce(
    input: BrowserTurnInput,
    context: TurnAttemptContext,
    hooks?: BrowserTurnHooks,
    requireRecoverableCheckpoint = false,
  ): Promise<IabTab> {
    throwIfCancelled(input.signal);
    const tab = await this.#getTab();
    throwIfCancelled(input.signal);
    const composer =
      (await findHydratedComposer(tab)) ??
      (await findUniqueLocator(tab, "textbox", COMPOSER_TEXTBOX_NAMES));
    if (!composer) {
      throw new CueLineError("COMPOSER_MISSING", "Could not find ChatGPT's message composer.");
    }
    context.selectedModelLabel = await this.#ensureProModel(tab, input.signal);
    context.baseline = await readPageChatState(tab);
    if (input.notSentRecovery !== undefined) {
      const currentUrl = context.baseline.pageUrl;
      const userMessageCount = context.baseline.userMessageCount ?? 0;
      if (
        !sameChatGptConversationUrl(currentUrl, input.notSentRecovery.conversationUrl) ||
        userMessageCount !== input.notSentRecovery.baselineUserMessageCount
      ) {
        throw new CueLineError(
          "CONTROLLER_NOT_SENT_CONFIRMATION_CONFLICT",
          "The exact conversation no longer matches the operator-confirmed not-sent baseline; refusing retry click.",
          {
            details: {
              stage: "pre_submit",
              submission_state: "definitely_not_sent",
              abandoned_request_id: input.notSentRecovery.abandonedRequestId,
              baseline_user_message_count:
                input.notSentRecovery.baselineUserMessageCount,
              observed_user_message_count: userMessageCount,
            },
          },
        );
      }
    }
    const composerBaseline = await readPageComposerState(
      tab,
      input.prompt,
      SEND_BUTTON_NAMES,
    );
    // A leftover attachment is provably CueLine's own converted prompt only on
    // an operator-confirmed not-sent retry whose abandoned attempt had reached
    // attachment_ready for this exact prompt. The retry rewrites the requestId
    // back to the abandoned one (controller-turn recovery), so undoing that
    // swap must reproduce the confirmed promptHash; the pre-submit guard above
    // already proved the same conversation and unchanged user-message count.
    // Reuse that single attachment instead of refusing; any other pre-existing
    // attachment stays refused so a user's own attachment is never mixed or cleared.
    const reusesConfirmedAttachmentPrompt =
      input.notSentRecovery !== undefined &&
      input.attachmentPromptExpected === true &&
      composerBaseline.attachmentCount === 1 &&
      commandHash(
        input.prompt
          .split(input.requestId)
          .join(input.notSentRecovery.abandonedRequestId),
      ) === input.notSentRecovery.promptHash;
    if (composerBaseline.attachmentCount > 0 && !reusesConfirmedAttachmentPrompt) {
      throw new CueLineError(
        "CONTROLLER_PROMPT_NOT_READY",
        "The ChatGPT composer already contains an attachment. Refusing to mix it with the current controller prompt.",
        {
          details: {
            composer_state: composerBaseline.state,
            attachment_count: composerBaseline.attachmentCount,
          },
        },
      );
    }
    if (!reusesConfirmedAttachmentPrompt) {
      await composer.fill(input.prompt, {});
    }
    throwIfCancelled(input.signal);
    context.composerPromptState = await this.#waitForComposerReady(
      tab,
      input.prompt,
      reusesConfirmedAttachmentPrompt ? 0 : composerBaseline.attachmentCount,
      input.signal,
    );
    const operationTimeoutMs = Math.min(
      SUBMISSION_ACTION_TIMEOUT_MS,
      this.#options.timeoutMs,
    );
    const sendTarget = await withBrowserOperationTimeout(
      () => this.#resolveSendTarget(tab),
      operationTimeoutMs,
      input.signal,
      () =>
        new CueLineError(
          "CONTROLLER_SUBMISSION_PRECLICK_TIMEOUT",
          `ChatGPT's send target did not resolve within ${operationTimeoutMs} ms; no send click was attempted.`,
        ),
    );
    await this.#emitCheckpoint(
      input,
      tab,
      context,
      hooks,
      "submitting",
      "attempting",
      context.baseline.pageUrl,
      context.baseline,
    );
    await this.#clickSend(tab, sendTarget, context.baseline, input, context, hooks);
    let capturedConversationUrl: string | undefined;
    if (requireRecoverableCheckpoint) {
      capturedConversationUrl = await captureConversationUrlAfterSubmit(
        tab,
        this.#conversationUrl,
        this.#options.timeoutMs,
        this.#options.pollIntervalMs,
        input.signal,
      );
      this.#conversationUrl = capturedConversationUrl;
    }
    const acknowledgement = await this.#waitForPostClickAcknowledgement(
      tab,
      input,
      context,
      capturedConversationUrl,
    );
    if (acknowledgement.status === "definitely_not_sent") {
      throw new CueLineError(
        "CONTROLLER_PROMPT_NOT_SENT",
        "The send click completed, but the exact staged prompt remained in the composer and ChatGPT did not start the controller turn.",
        { details: { submission_state: "definitely_not_sent" } },
      );
    }
    if (acknowledgement.status === "possibly_sent") {
      await this.#emitCheckpoint(
        input,
        tab,
        context,
        hooks,
        "possibly_sent",
        "accepted",
        capturedConversationUrl,
        acknowledgement.state,
      );
      throw new CueLineError(
        "CONTROLLER_SUBMISSION_AMBIGUOUS",
        "The staged prompt left the composer without enough evidence to prove submission. Refusing a second click; reconcile the exact conversation instead.",
        { details: { submission_state: "possibly_sent" } },
      );
    }
    context.stage = "submitted";
    await this.#emitCheckpoint(
      input,
      tab,
      context,
      hooks,
      "submitted",
      "accepted",
      capturedConversationUrl,
      acknowledgement.state,
    );
    return tab;
  }

  async #sendTurnOnce(
    input: BrowserTurnInput,
    context: TurnAttemptContext,
    hooks?: BrowserTurnHooks,
  ): Promise<ControllerTurn> {
    const tab = await this.#submitTurnOnce(input, context, hooks);
    const completed = await this.#waitForCompletion(
      tab,
      context.baseline!,
      input.notSentRecovery,
      input.signal,
    );
    return this.#resultFromCompletedTurn(tab, context.selectedModelLabel!, completed);
  }

  async #emitCheckpoint(
    input: BrowserTurnInput,
    tab: IabTab,
    context: TurnAttemptContext,
    hooks: BrowserTurnHooks | undefined,
    submissionState: "submitting" | "possibly_sent" | "submitted",
    clickAttemptState: "attempting" | "accepted" | "error",
    capturedConversationUrl?: string,
    observedState?: PageChatState | null,
    clickError?: unknown,
  ): Promise<void> {
    if (!context.baseline || !context.selectedModelLabel || !context.composerPromptState) return;
    const currentUrl = capturedConversationUrl ?? context.baseline.pageUrl;
    const checkpointUrl = isConversationUrl(currentUrl) ? currentUrl : this.#conversationUrl;
    if (checkpointUrl !== undefined && isConversationUrl(checkpointUrl)) {
      this.#conversationUrl = checkpointUrl;
    }
    const domState = observedState === null ? undefined : observedState ?? context.baseline;
    const baselineLastUserMessageHash =
      context.baseline.lastUserText === null
        ? null
        : commandHash(normalizedMessageText(context.baseline.lastUserText));
    await hooks?.onCheckpoint?.({
      submissionState,
      composerPromptState: context.composerPromptState,
      ...(checkpointUrl !== undefined && isConversationUrl(checkpointUrl)
        ? { conversationUrl: checkpointUrl }
        : {}),
      selectedModelLabel: context.selectedModelLabel,
      runId: input.runId,
      round: input.round,
      requestId: input.requestId,
      promptHash: commandHash(input.prompt),
      modelEvidenceSource: "composer",
      baselineUserMessageCount: context.baseline.userMessageCount ?? 0,
      baselineAssistantMessageCount: context.baseline.assistantMessageCount,
      baselineLastUserMessageHash,
      clickAttemptState,
      ...(clickError instanceof Error
        ? {
            clickErrorName: clickError.name.slice(0, 128),
            clickErrorMessage: clickError.message.slice(0, 500),
          }
        : clickError === undefined
          ? {}
          : { clickErrorMessage: String(clickError).slice(0, 500) }),
      ...(domState === undefined
        ? {}
        : {
            domEvidence: {
              pageUrl: domState.pageUrl,
              userMessageCount: domState.userMessageCount ?? 0,
              assistantMessageCount: domState.assistantMessageCount,
              lastMessageRole: domState.lastMessageRole,
              lastUserMessageHash:
                domState.lastUserText === null
                  ? null
                  : commandHash(normalizedMessageText(domState.lastUserText)),
              isAnswering: domState.isAnswering,
            },
          }),
    });
  }

  #browserFailure(
    error: unknown,
    context: TurnAttemptContext,
    input: BrowserTurnInput,
  ): CueLineError {
    const message = error instanceof Error ? error.message : String(error);
    const submissionState = submissionStateForStage(context.stage);
    const existingDetails =
      error instanceof CueLineError &&
      typeof error.details === "object" &&
      error.details !== null &&
      !Array.isArray(error.details)
        ? (error.details as Record<string, unknown>)
        : {};
    return new CueLineError(
      error instanceof CueLineError
        ? error.code
        : context.stage === "pre_submit"
          ? "IAB_ATTACH_FAILED"
          : "IAB_READ_FAILED_AFTER_SUBMIT",
      message,
      {
        cause: error,
        details: {
          ...existingDetails,
          stage: context.stage,
          submission_state:
            existingDetails.submission_state === "definitely_not_sent" ||
            existingDetails.submission_state === "possibly_sent" ||
            existingDetails.submission_state === "submitted"
              ? existingDetails.submission_state
              : submissionState,
          request_id: input.requestId,
        },
      },
    );
  }

  async sendTurn(input: BrowserTurnInput, hooks?: BrowserTurnHooks): Promise<ControllerTurn> {
    const context: TurnAttemptContext = { stage: "pre_submit" };
    try {
      return await this.#sendTurnOnce(input, context, hooks);
    } catch (error) {
      if (!isTabUnavailableError(error)) throw this.#browserFailure(error, context, input);
      this.#tab = undefined;
      if (context.stage === "pre_submit") {
        const retryContext: TurnAttemptContext = { stage: "pre_submit" };
        return this.#sendTurnOnce(input, retryContext, hooks).catch((retryError) => {
          throw this.#browserFailure(retryError, retryContext, input);
        });
      }
      if (this.#conversationUrl === undefined) {
        throw new CueLineError(
          "TAB_RECOVERY_UNSAFE",
          "The ChatGPT tab disappeared before CueLine captured an exact conversation URL; refusing a potentially duplicate send.",
          {
            cause: error,
            details: {
              stage: context.stage,
              submission_state: submissionStateForStage(context.stage),
              request_id: input.requestId,
            },
          },
        );
      }
      if (!context.baseline || !context.selectedModelLabel) throw error;
      try {
        const recoveredTab = await this.#getTab();
        const recoveredState = await readPageChatState(recoveredTab);
        const responseStarted =
          recoveredState.isAnswering ||
          recoveredState.assistantMessageCount > context.baseline.assistantMessageCount;
        if (context.stage === "submitting" && !responseStarted) {
          throw new CueLineError(
            "TAB_RECOVERY_UNSAFE",
            "The ChatGPT tab disappeared while submitting, and CueLine cannot prove whether the prompt was sent. Refusing a duplicate send.",
            {
              cause: error,
              details: {
                stage: context.stage,
                submission_state: "possibly_sent",
                request_id: input.requestId,
              },
            },
          );
        }
        const completed = await this.#waitForCompletion(
          recoveredTab,
          context.baseline,
          input.notSentRecovery,
          input.signal,
        );
        return this.#resultFromCompletedTurn(
          recoveredTab,
          context.selectedModelLabel,
          completed,
        );
      } catch (recoveryError) {
        throw this.#browserFailure(recoveryError, context, input);
      }
    }
  }

  async submitTurn(input: BrowserTurnInput, hooks?: BrowserTurnHooks): Promise<void> {
    const context: TurnAttemptContext = { stage: "pre_submit" };
    try {
      await this.#submitTurnOnce(input, context, hooks, true);
    } catch (error) {
      if (!isTabUnavailableError(error) || context.stage !== "pre_submit") {
        throw this.#browserFailure(error, context, input);
      }
      this.#tab = undefined;
      const retryContext: TurnAttemptContext = { stage: "pre_submit" };
      await this.#submitTurnOnce(input, retryContext, hooks, true).catch((retryError) => {
        throw this.#browserFailure(retryError, retryContext, input);
      });
    }
  }

  async #observeSubmittedDelivery(
    tab: IabTab,
    input: BrowserTurnInput,
    selectedModelLabel: string,
  ): Promise<BrowserSubmittedTurnObservation> {
    const legacyPreSubmissionRecovery = input.legacyPreSubmissionRecovery === true;
    const baselineUserMessageCount = input.baselineUserMessageCount;
    if (
      !legacyPreSubmissionRecovery &&
      (!Number.isSafeInteger(baselineUserMessageCount) ||
        (baselineUserMessageCount ?? -1) < 0)
    ) {
      return { status: "pending" };
    }
    const deadline =
      Date.now() +
      Math.min(this.#options.timeoutMs, SUBMITTED_RECOVERY_HYDRATION_TIMEOUT_MS);
    const operationTimeoutMs = Math.min(
      SUBMISSION_ACTION_TIMEOUT_MS,
      this.#options.timeoutMs,
    );
    let stableSignature = "";
    let stableSince = 0;
    let lastEvidence: BrowserSubmittedTurnEvidence | undefined;

    for (;;) {
      throwIfCancelled(input.signal);
      const state = await withBrowserOperationTimeout(
        () => readPageChatState(tab),
        operationTimeoutMs,
        input.signal,
        () =>
          new CueLineError(
            "CONTROLLER_RECONCILIATION_READ_TIMEOUT",
            `ChatGPT's submitted-turn state read did not finish within ${operationTimeoutMs} ms.`,
          ),
      );
      const composerState = await withBrowserOperationTimeout(
        () => readPageComposerState(tab, input.prompt, SEND_BUTTON_NAMES),
        operationTimeoutMs,
        input.signal,
        () =>
          new CueLineError(
            "CONTROLLER_RECONCILIATION_READ_TIMEOUT",
            `ChatGPT's submitted-turn composer read did not finish within ${operationTimeoutMs} ms.`,
          ),
      );
      if (!sameChatGptConversationUrl(state.pageUrl, this.#conversationUrl!)) {
        throw new CueLineError(
          "CONTROLLER_RECONCILIATION_CONVERSATION_MISMATCH",
          "Submitted-turn evidence was read from a different ChatGPT conversation DOM.",
        );
      }
      const observedUserMessageCount =
        Number.isSafeInteger(state.userMessageCount) &&
        (state.userMessageCount ?? -1) >= 0
          ? state.userMessageCount!
          : null;
      const baseline = Number.isSafeInteger(baselineUserMessageCount)
        ? baselineUserMessageCount!
        : observedUserMessageCount;
      const baselineLoaded =
        baseline !== null &&
        observedUserMessageCount !== null &&
        observedUserMessageCount >= baseline;
      const requestMessageFound = baselineLoaded
        ? state.lastUserText !== null &&
          (normalizedMessageText(state.lastUserText) ===
            normalizedMessageText(input.prompt) ||
            state.lastUserText.includes(input.requestId))
        : null;
      const now = Date.now();
      const hydrated =
        baselineLoaded && (baseline! > 0 || now >= deadline);
      const evidence: BrowserSubmittedTurnEvidence = {
        conversationUrl: state.pageUrl,
        selectedModelLabel,
        hydrated,
        baselineUserMessageCount: baseline ?? 0,
        observedUserMessageCount,
        requestMessageFound,
        isAnswering: baselineLoaded ? state.isAnswering : null,
        composerPromptState: composerState.state,
        composerAttachmentCount: composerState.attachmentCount,
        composerSendButtonEnabled: composerState.sendButtonEnabled,
      };
      lastEvidence = evidence;

      const stagedPromptRemains = legacyPreSubmissionRecovery
        ? true
        : input.attachmentPromptExpected === true
          ? composerState.state === "attachment_ready" &&
            composerState.attachmentCount > 0 &&
            composerState.sendButtonEnabled
          : composerState.state === "inline_ready" &&
            composerState.sendButtonEnabled;
      const notSentCandidate =
        baseline !== null &&
        observedUserMessageCount === baseline &&
        requestMessageFound === false &&
        state.isAnswering === false &&
        stagedPromptRemains;
      if (notSentCandidate) {
        const signature = `${observedUserMessageCount}:${state.assistantMessageCount}:${state.lastMessageRole}:${state.lastUserText ?? ""}:${composerState.state}:${composerState.attachmentCount}:${composerState.sendButtonEnabled}`;
        if (signature !== stableSignature) {
          stableSignature = signature;
          stableSince = now;
        }
        if (hydrated && now - stableSince >= this.#options.stableMs) {
          return { status: "definitely_not_sent", evidence };
        }
      } else {
        stableSignature = "";
        stableSince = 0;
      }

      if (
        baselineLoaded &&
        observedUserMessageCount !== null &&
        observedUserMessageCount > baseline
      ) {
        const turn = await this.#readExistingTurn(input, false);
        return turn === undefined
          ? { status: "pending", evidence }
          : { status: "response", turn };
      }
      if (baselineLoaded && (requestMessageFound === true || state.isAnswering)) {
        return { status: "pending", evidence };
      }
      if (now >= deadline) {
        return lastEvidence === undefined
          ? { status: "pending" }
          : { status: "pending", evidence: lastEvidence };
      }
      await delay(
        Math.min(this.#options.pollIntervalMs, Math.max(1, deadline - now)),
        input.signal,
      );
    }
  }

  async observeSubmittedTurn(
    input: BrowserTurnInput,
  ): Promise<BrowserSubmittedTurnObservation> {
    try {
      if (this.#conversationUrl === undefined) {
        throw new CueLineError(
          "CONTROLLER_RECONCILIATION_URL_REQUIRED",
          "CueLine needs the exact persisted ChatGPT conversation URL for submitted-turn recovery.",
        );
      }
      const tab = await this.#getTab();
      const selectedModelLabel = await readComposerModelLabelWhenReady(
        tab,
        input.signal,
      );
      if (!isProLabel(selectedModelLabel)) {
        throw new CueLineError(
          "CONTROLLER_RECONCILIATION_MODEL_UNVERIFIED",
          "The existing conversation does not currently expose a Pro composer label; refusing submitted-turn recovery.",
        );
      }
      return await this.#observeSubmittedDelivery(tab, input, selectedModelLabel);
    } catch (error) {
      throw this.#reconciliationFailure(error, input);
    }
  }

  async #readExistingTurn(
    input: BrowserTurnInput,
    waitForCompletion: boolean,
  ): Promise<ControllerTurn | undefined> {
    throwIfCancelled(input.signal);
    if (this.#conversationUrl === undefined) {
      throw new CueLineError(
        "CONTROLLER_RECONCILIATION_URL_REQUIRED",
        "CueLine needs the exact persisted ChatGPT conversation URL to recover without sending.",
        {
          details: {
            stage: "reconciling",
            submission_state: "possibly_sent",
            request_id: input.requestId,
          },
        },
      );
    }
    const tab = await this.#getTab();
    throwIfCancelled(input.signal);
    const selectedModelLabel = await readComposerModelLabelWhenReady(tab, input.signal);
    if (!isProLabel(selectedModelLabel)) {
      throw new CueLineError(
        "CONTROLLER_RECONCILIATION_MODEL_UNVERIFIED",
        "The existing conversation does not currently expose a Pro composer label; refusing to import the response without both model checks.",
      );
    }
    const allowVisiblePromptMismatch =
      input.manualSendConfirmed === true || input.attachmentPromptExpected === true;
    const baselineAssistantMessageCount =
      typeof input.baselineAssistantMessageCount === "number" &&
      Number.isSafeInteger(input.baselineAssistantMessageCount) &&
      input.baselineAssistantMessageCount >= 0
        ? input.baselineAssistantMessageCount
        : undefined;
    const expectedIdentity: ExpectedControllerIdentity = {
      runId: input.runId, round: input.round, requestId: input.requestId,
    };
    const completed = waitForCompletion
      ? await this.#waitForRecoveredCompletion(
          tab,
          input.prompt,
          allowVisiblePromptMismatch,
          input.manualSendConfirmed === true,
          baselineAssistantMessageCount,
          this.#conversationUrl,
          expectedIdentity,
          input.signal,
        )
      : await this.#observeRecoveredCompletion(
          tab,
          input.prompt,
          allowVisiblePromptMismatch,
          input.manualSendConfirmed === true,
          baselineAssistantMessageCount,
          this.#conversationUrl,
          expectedIdentity,
          input.signal,
        );
    if (completed === undefined) return undefined;
    if (
      input.notSentRecovery !== undefined &&
      input.manualSendConfirmed !== true &&
      (completed.userMessageCount ?? 0) >
        input.notSentRecovery.baselineUserMessageCount + 1
    ) {
      throw new CueLineError(
        "CONTROLLER_NOT_SENT_CONFIRMATION_CONFLICT",
        "The abandoned controller message appeared during retry recovery; freezing the run.",
        {
          details: {
            stage: "reconciling_retry",
            submission_state: "possibly_sent",
            abandoned_request_id: input.notSentRecovery.abandonedRequestId,
            baseline_user_message_count:
              input.notSentRecovery.baselineUserMessageCount,
            observed_user_message_count: completed.userMessageCount ?? 0,
          },
        },
      );
    }
    const recoveredUrl = (await tab.url()) ?? "";
    if (!sameChatGptConversationUrl(recoveredUrl, this.#conversationUrl)) {
      throw new CueLineError(
        "CONTROLLER_RECONCILIATION_CONVERSATION_MISMATCH",
        "The recovered response is no longer on the exact persisted ChatGPT conversation URL.",
      );
    }
    return this.#resultFromCompletedTurn(tab, selectedModelLabel, completed);
  }

  #reconciliationFailure(error: unknown, input: BrowserTurnInput): CueLineError {
    const message = error instanceof Error ? error.message : String(error);
    const existingDetails =
      error instanceof CueLineError &&
      typeof error.details === "object" &&
      error.details !== null &&
      !Array.isArray(error.details)
        ? (error.details as Record<string, unknown>)
        : {};
    return new CueLineError(
      error instanceof CueLineError ? error.code : "IAB_RECONCILIATION_FAILED",
      message,
      {
        cause: error,
        details: {
          ...existingDetails,
          stage: "reconciling",
          submission_state: "possibly_sent",
          request_id: input.requestId,
        },
      },
    );
  }

  async observeTurn(input: BrowserTurnInput): Promise<ControllerTurn | undefined> {
    try {
      return await this.#readExistingTurn(input, false);
    } catch (error) {
      throw this.#reconciliationFailure(error, input);
    }
  }

  async recoverTurn(input: BrowserTurnInput): Promise<ControllerTurn> {
    try {
      const turn = await this.#readExistingTurn(input, true);
      if (turn === undefined) throw new Error("IAB_RECOVERY_RETURNED_WITHOUT_RESPONSE");
      return turn;
    } catch (error) {
      throw this.#reconciliationFailure(error, input);
    }
  }

  async archiveConversation(
    input: BrowserConversationArchiveInput,
    hooks: BrowserConversationArchiveHooks = {},
  ): Promise<BrowserConversationArchiveEvidence> {
    throwIfCancelled(input.signal);
    if (!isConversationUrl(input.conversationUrl)) {
      throw new CueLineError(
        "CONTROLLER_CONVERSATION_ARCHIVE_URL_REQUIRED",
        "Archiving requires one exact ChatGPT /c/<conversation-id> URL.",
      );
    }
    if (
      this.#conversationUrl !== undefined &&
      !sameChatGptConversationUrl(this.#conversationUrl, input.conversationUrl)
    ) {
      throw new CueLineError(
        "CONTROLLER_CONVERSATION_ARCHIVE_MISMATCH",
        "The archive request does not match the adapter's bound controller conversation.",
      );
    }
    this.#conversationUrl = input.conversationUrl;
    const tab = await this.#getTab();
    const pageUrl = (await tab.url()) ?? "";
    if (!sameChatGptConversationUrl(pageUrl, input.conversationUrl)) {
      throw new CueLineError(
        "CONTROLLER_CONVERSATION_ARCHIVE_MISMATCH",
        "The active ChatGPT tab is not the completed controller conversation.",
      );
    }
    const pageState = await readPageChatState(tab);
    if (!sameChatGptConversationUrl(pageState.pageUrl, input.conversationUrl)) {
      throw new CueLineError(
        "CONTROLLER_CONVERSATION_ARCHIVE_MISMATCH",
        "The ChatGPT page changed before archive controls could be opened.",
      );
    }
    if (pageState.isAnswering) {
      throw new CueLineError(
        "CONTROLLER_CONVERSATION_ARCHIVE_PRO_ACTIVE",
        "ChatGPT Pro is still answering. Refusing to open or archive the conversation.",
      );
    }
    if (!tab.playwright.locator) {
      throw new CueLineError(
        "CONTROLLER_CONVERSATION_ARCHIVE_UNAVAILABLE",
        "The browser cannot locate ChatGPT's conversation options button.",
      );
    }
    const optionsButton = tab.playwright.locator(CONVERSATION_OPTIONS_SELECTOR);
    if (!(await isActionableLocator(optionsButton))) {
      throw new CueLineError(
        "CONTROLLER_CONVERSATION_ARCHIVE_UNAVAILABLE",
        "ChatGPT's conversation options button is missing, hidden, disabled, or ambiguous.",
      );
    }
    await optionsButton.click({ timeoutMs: 10_000 });
    const archiveItem = await findUniqueLocator(
      tab,
      "menuitem",
      ARCHIVE_MENUITEM_NAMES,
    );
    if (!archiveItem || !(await isActionableLocator(archiveItem))) {
      throw new CueLineError(
        "CONTROLLER_CONVERSATION_ARCHIVE_UNAVAILABLE",
        "ChatGPT's Archive menu item is missing, hidden, disabled, or ambiguous.",
      );
    }
    const finalPageState = await readPageChatState(tab);
    if (!sameChatGptConversationUrl(finalPageState.pageUrl, input.conversationUrl)) {
      throw new CueLineError(
        "CONTROLLER_CONVERSATION_ARCHIVE_MISMATCH",
        "The ChatGPT page changed before the archive click. Refusing to archive another conversation.",
      );
    }
    if (finalPageState.isAnswering) {
      throw new CueLineError(
        "CONTROLLER_CONVERSATION_ARCHIVE_PRO_ACTIVE",
        "ChatGPT Pro started answering before the archive click. Refusing to archive the conversation.",
      );
    }

    throwIfCancelled(input.signal);
    await hooks.onBeforeArchiveClick?.();
    throwIfCancelled(input.signal);
    const checkpointPageState = await readPageChatState(tab);
    if (!sameChatGptConversationUrl(checkpointPageState.pageUrl, input.conversationUrl)) {
      throw new CueLineError(
        "CONTROLLER_CONVERSATION_ARCHIVE_MISMATCH",
        "The ChatGPT page changed during the archive checkpoint. Refusing to archive another conversation.",
      );
    }
    if (checkpointPageState.isAnswering) {
      throw new CueLineError(
        "CONTROLLER_CONVERSATION_ARCHIVE_PRO_ACTIVE",
        "ChatGPT Pro started answering during the archive checkpoint. Refusing to archive the conversation.",
      );
    }

    let clickFailure: unknown;
    try {
      await archiveItem.click({ timeoutMs: 10_000 });
    } catch (error) {
      clickFailure = error;
    }

    const deadline = Date.now() + Math.min(this.#options.timeoutMs, ARCHIVE_PROOF_TIMEOUT_MS);
    while (true) {
      throwIfCancelled(input.signal);
      const postActionUrl = (await tab.url().catch(() => undefined)) ?? "";
      if (
        postActionUrl.startsWith(CHATGPT_URL) &&
        !sameChatGptConversationUrl(postActionUrl, input.conversationUrl)
      ) {
        this.#tab = undefined;
        return {
          conversationUrl: input.conversationUrl,
          proof: "conversation_url_changed",
          postActionUrl,
        };
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await tab.playwright.waitForTimeout(
        Math.min(this.#options.pollIntervalMs, remainingMs),
      );
    }
    throw new CueLineError(
      "CONTROLLER_CONVERSATION_ARCHIVE_AMBIGUOUS",
      "ChatGPT did not expose durable proof that the controller conversation was archived. Refusing another archive click.",
      { cause: clickFailure },
    );
  }
}

export function createCodexIabAdapter(options: CodexIabAdapterOptions = {}): BrowserAdapter {
  return new CodexIabAdapter(options);
}
