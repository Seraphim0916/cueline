import type {
  BrowserAdapter,
  BrowserTurnHooks,
  BrowserTurnInput,
  ControllerModelEvidence,
  ControllerTurn,
} from "../browser-adapter.js";
import { CueLineError } from "../../core/errors.js";
import {
  readPageChatState,
  resolveIabBrowser,
  type IabBrowser,
  type IabLocator,
  type IabTab,
  type PageChatState,
} from "./bootstrap.js";
import { CHATGPT_URL, COMPOSER_TEXTBOX_NAMES, SEND_BUTTON_NAMES } from "./selectors.js";

export interface CodexIabAdapterOptions {
  browser?: IabBrowser;
  conversationUrl?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  stableMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_STABLE_MS = 1_500;
const COMPOSER_HYDRATION_TIMEOUT_MS = 5_000;
const CONTENTEDITABLE_COMPOSER_SELECTOR = '#prompt-textarea[contenteditable="true"]';
const MODEL_PICKER_SELECTOR = "button.__composer-pill";
const REQUIRED_MODEL_LABEL = "Pro";
const MODEL_LABEL_READ_ATTEMPTS = 50;
const MODEL_LABEL_RETRY_INTERVAL_MS = 100;
const TAB_DISCOVERY_RETRY_MS = 100;

type TurnStage = "pre_submit" | "submitting" | "submitted";

interface TurnAttemptContext {
  stage: TurnStage;
  baseline?: PageChatState;
  selectedModelLabel?: string;
}

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

async function clickVisibleSendButtonByCoordinates(tab: IabTab): Promise<boolean> {
  if (!tab.cua?.click) return false;
  const target = await tab.playwright.evaluate(
    ({ sendButtonNames }) => {
      const normalize = (value: unknown): string =>
        String(value ?? "").trim().replace(/\s+/g, " ");
      const candidates = Array.from(document.querySelectorAll("button")).filter((element) => {
        const button = element as HTMLButtonElement;
        const style = window.getComputedStyle(button);
        const rect = button.getBoundingClientRect();
        const label = normalize(
          button.getAttribute("aria-label") ?? button.innerText ?? button.textContent,
        );
        return (
          sendButtonNames.some((name) => name === label) &&
          !button.disabled &&
          button.getAttribute("aria-disabled") !== "true" &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0 &&
          rect.right > 0 &&
          rect.bottom > 0 &&
          rect.left < window.innerWidth &&
          rect.top < window.innerHeight
        );
      });
      if (candidates.length !== 1) return null;
      const rect = candidates[0]!.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    },
    { sendButtonNames: [...SEND_BUTTON_NAMES] },
  ).catch(() => null);
  if (
    target === null ||
    !Number.isFinite(target.x) ||
    !Number.isFinite(target.y) ||
    target.x < 0 ||
    target.y < 0
  ) {
    return false;
  }
  await tab.cua.click({ x: Math.round(target.x), y: Math.round(target.y) });
  await tab.playwright.waitForTimeout(100);
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

function isConversationUrl(url: string): boolean {
  return /^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+/.test(url);
}

function isTransientClickError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /deadline exceeded|timed? out|timeout|detached|stale|not enabled|not visible/i.test(message);
}

function isTabUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /tab not found|existing tabs: none|webview attach|cdp operation exceeded|target closed|page closed|browser.*disconnected/i.test(
    message,
  );
}

function normalizedConversationUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function isProLabel(label: string | null): label is string {
  return /^Pro(?:\s+(?:Standard|Extended))?$/i.test(label ?? "");
}

function isProModelSlug(slug: string | null): slug is string {
  return /(?:^|-)pro(?:-|$)/i.test(slug ?? "");
}

function normalizedMessageText(value: string | null): string {
  return (value ?? "").replace(/\r\n/g, "\n").trim();
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
  readonly #options: Required<Pick<CodexIabAdapterOptions, "timeoutMs" | "pollIntervalMs" | "stableMs">> &
    Pick<CodexIabAdapterOptions, "browser" | "conversationUrl">;
  #browser: IabBrowser | undefined;
  #tab: IabTab | undefined;
  #conversationUrl: string | undefined;

  constructor(options: CodexIabAdapterOptions) {
    this.#options = {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      stableMs: options.stableMs ?? DEFAULT_STABLE_MS,
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
            normalizedConversationUrl(cachedUrl) === normalizedConversationUrl(expected))
        ) {
          return this.#tab;
        }
      } catch (error) {
        if (!isTabUnavailableError(error)) throw error;
      }
      this.#tab = undefined;
    }
    const browser = await this.#getBrowser();
    const targetUrl = this.#conversationUrl;
    const matchesTarget = (url: string): boolean =>
      targetUrl
        ? normalizedConversationUrl(url) === normalizedConversationUrl(targetUrl)
        : url.startsWith(CHATGPT_URL);
    let tab: IabTab | undefined;
    const canDiscover =
      browser.tabs.selected !== undefined ||
      browser.tabs.list !== undefined ||
      browser.user?.openTabs !== undefined;
    const discoveryPasses = canDiscover ? 2 : 1;
    for (let pass = 0; pass < discoveryPasses && tab === undefined; pass += 1) {
      const selected = await browser.tabs.selected?.();
      if (selected && matchesTarget((await selected.url()) ?? "")) {
        tab = selected;
        break;
      }
      const sessionTabs = (await browser.tabs.list?.()) ?? [];
      const sessionCandidate = sessionTabs.find((candidate) =>
        matchesTarget(String(candidate.url ?? "")),
      );
      if (sessionCandidate?.id && browser.tabs.get) {
        tab = await browser.tabs.get(sessionCandidate.id);
      }
      if (tab === undefined) {
        const openTabs = (await browser.user?.openTabs?.()) ?? [];
        const candidate = openTabs.find((openTab) =>
          matchesTarget(String(openTab.url ?? "")),
        );
        if (candidate && browser.user?.claimTab) {
          tab = await browser.user.claimTab(candidate);
        }
      }
      if (tab === undefined && pass < discoveryPasses - 1) {
        await delay(TAB_DISCOVERY_RETRY_MS);
      }
    }
    if (tab === undefined) {
      tab = await browser.tabs.new();
      await tab.goto(targetUrl ?? CHATGPT_URL);
    }
    await tab.playwright.waitForLoadState?.({
      state: "domcontentloaded",
      timeoutMs: 30_000,
    });
    this.#tab = tab;
    return tab;
  }

  async #ensureProModel(tab: IabTab): Promise<string> {
    let label = await readComposerModelLabel(tab);
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

  async #submissionStarted(tab: IabTab, previousUrl: string): Promise<boolean> {
    const currentUrl = (await tab.url().catch(() => previousUrl)) ?? previousUrl;
    if (!isConversationUrl(previousUrl) && isConversationUrl(currentUrl)) {
      return true;
    }
    return (
      await readPageChatState(tab).catch(() => ({
        isAnswering: false,
        assistantText: "",
        assistantMessageCount: 0,
        assistantModelSlug: null,
        lastUserText: null,
        lastMessageRole: null,
      }))
    ).isAnswering;
  }

  async #clickSend(tab: IabTab): Promise<void> {
    const previousUrl = (await tab.url()) ?? "";
    let lastError: unknown;
    let locatorClickAttempted = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const button = await findUniqueLocator(tab, "button", SEND_BUTTON_NAMES);
      if (!button) {
        if (attempt > 0 && await this.#submissionStarted(tab, previousUrl)) {
          return;
        }
        lastError = new CueLineError(
          "SEND_BUTTON_MISSING",
          "Could not find ChatGPT's send button.",
        );
        break;
      }
      try {
        locatorClickAttempted = true;
        await button.click({ timeoutMs: 10_000 });
        return;
      } catch (error) {
        if (await this.#submissionStarted(tab, previousUrl)) {
          return;
        }
        if (!isTransientClickError(error)) {
          throw error;
        }
        lastError = error;
        if (attempt === 0) {
          await tab.playwright.domSnapshot();
          await tab.playwright.waitForTimeout(250);
          if (await this.#submissionStarted(tab, previousUrl)) return;
          if (await clickVisibleSendButtonByCoordinates(tab)) return;
        }
      }
    }
    if (!locatorClickAttempted && await clickVisibleSendButtonByCoordinates(tab)) return;
    throw lastError ?? new CueLineError(
      "SEND_BUTTON_MISSING",
      "Could not find ChatGPT's send button.",
    );
  }

  async #waitForCompletion(
    tab: IabTab,
    baseline: PageChatState,
    signal?: AbortSignal,
  ): Promise<PageChatState> {
    const deadline = Date.now() + this.#options.timeoutMs;
    let stableText = "";
    let stableSince = 0;
    let responseStarted = false;
    while (Date.now() < deadline) {
      throwIfCancelled(signal);
      const state = await readPageChatState(tab);
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
    signal?: AbortSignal,
  ): Promise<PageChatState> {
    const deadline = Date.now() + this.#options.timeoutMs;
    let stableText = "";
    let stableSince = 0;
    while (Date.now() < deadline) {
      throwIfCancelled(signal);
      const state = await readPageChatState(tab);
      if (normalizedMessageText(state.lastUserText) !== normalizedMessageText(expectedPrompt)) {
        throw new CueLineError(
          "CONTROLLER_RECONCILIATION_MISMATCH",
          "The exact conversation's last user message does not match the pending CueLine prompt. Refusing to import an unrelated response.",
        );
      }
      if (
        !state.isAnswering &&
        state.lastMessageRole === "assistant" &&
        state.assistantText !== ""
      ) {
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
    const conversationUrl = (await tab.url()) ?? "";
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

  async #sendTurnOnce(
    input: BrowserTurnInput,
    context: TurnAttemptContext,
    hooks?: BrowserTurnHooks,
  ): Promise<ControllerTurn> {
    throwIfCancelled(input.signal);
    const tab = await this.#getTab();
    throwIfCancelled(input.signal);
    const composer =
      (await findHydratedComposer(tab)) ??
      (await findUniqueLocator(tab, "textbox", COMPOSER_TEXTBOX_NAMES));
    if (!composer) {
      throw new CueLineError("COMPOSER_MISSING", "Could not find ChatGPT's message composer.");
    }
    context.selectedModelLabel = await this.#ensureProModel(tab);
    context.baseline = await readPageChatState(tab);
    await composer.fill(input.prompt, {});
    throwIfCancelled(input.signal);
    await this.#emitCheckpoint(tab, context, hooks, "possibly_sent");
    context.stage = "submitting";
    await this.#clickSend(tab);
    context.stage = "submitted";
    await this.#emitCheckpoint(tab, context, hooks, "submitted");
    const completed = await this.#waitForCompletion(tab, context.baseline, input.signal);
    return this.#resultFromCompletedTurn(tab, context.selectedModelLabel, completed);
  }

  async #emitCheckpoint(
    tab: IabTab,
    context: TurnAttemptContext,
    hooks: BrowserTurnHooks | undefined,
    submissionState: "possibly_sent" | "submitted",
  ): Promise<void> {
    if (!context.baseline || !context.selectedModelLabel) return;
    const currentUrl = (await tab.url().catch(() => "")) ?? "";
    if (isConversationUrl(currentUrl)) this.#conversationUrl = currentUrl;
    await hooks?.onCheckpoint?.({
      submissionState,
      ...(isConversationUrl(currentUrl) ? { conversationUrl: currentUrl } : {}),
      selectedModelLabel: context.selectedModelLabel,
      baselineAssistantMessageCount: context.baseline.assistantMessageCount,
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
          submission_state: submissionState,
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

  async recoverTurn(input: BrowserTurnInput): Promise<ControllerTurn> {
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
    try {
      const tab = await this.#getTab();
      throwIfCancelled(input.signal);
      const selectedModelLabel = await readComposerModelLabelWhenReady(tab, input.signal);
      if (!isProLabel(selectedModelLabel)) {
        throw new CueLineError(
          "CONTROLLER_RECONCILIATION_MODEL_UNVERIFIED",
          "The existing conversation does not currently expose a Pro composer label; refusing to import the response without both model checks.",
        );
      }
      const completed = await this.#waitForRecoveredCompletion(
        tab,
        input.prompt,
        input.signal,
      );
      return this.#resultFromCompletedTurn(tab, selectedModelLabel, completed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const existingDetails =
        error instanceof CueLineError &&
        typeof error.details === "object" &&
        error.details !== null &&
        !Array.isArray(error.details)
          ? (error.details as Record<string, unknown>)
          : {};
      throw new CueLineError(
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
  }
}

export function createCodexIabAdapter(options: CodexIabAdapterOptions = {}): BrowserAdapter {
  return new CodexIabAdapter(options);
}
