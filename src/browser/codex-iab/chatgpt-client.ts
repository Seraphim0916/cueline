import type {
  BrowserAdapter,
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

type TurnStage = "pre_submit" | "submitting" | "submitted";

interface TurnAttemptContext {
  stage: TurnStage;
  baseline?: PageChatState;
  selectedModelLabel?: string;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

async function readComposerModelLabel(tab: IabTab): Promise<string | null> {
  return tab.playwright.evaluate(
    ({ modelPickerSelector }) => {
      const knownModel = /^(?:Instant(?:\s+\d+(?:\.\d+)*)?|Medium|High|Extra High|Thinking|Auto|Pro(?:\s+(?:Standard|Extended))?)$/i;
      const labels = Array.from(document.querySelectorAll(modelPickerSelector))
        .map((element) => String((element as HTMLElement).innerText ?? element.textContent ?? ""))
        .map((label) => label.replace(/\s+/g, " ").trim())
        .filter((label) => knownModel.test(label));
      return labels.length === 1 ? labels[0]! : null;
    },
    { modelPickerSelector: MODEL_PICKER_SELECTOR },
  );
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
    const selected = await browser.tabs.selected?.().catch(() => undefined);
    if (selected && matchesTarget((await selected.url().catch(() => "")) ?? "")) {
      this.#tab = selected;
      return selected;
    }
    const sessionTabs = await browser.tabs.list?.().catch(() => []);
    const sessionCandidate = sessionTabs?.find((tab) => matchesTarget(String(tab.url ?? "")));
    let tab: IabTab | undefined;
    if (sessionCandidate?.id && browser.tabs.get) {
      tab = await browser.tabs.get(sessionCandidate.id);
    }
    const openTabs = tab === undefined ? await browser.user?.openTabs?.().catch(() => []) : [];
    const candidate = openTabs?.find((openTab) => {
      const url = String(openTab.url ?? "");
      return matchesTarget(url);
    });
    if (tab === undefined && candidate && browser.user?.claimTab) {
      tab = await browser.user.claimTab(candidate);
    } else if (tab === undefined) {
      tab = await browser.tabs.new();
      await tab.goto(targetUrl ?? CHATGPT_URL);
    }
    this.#tab = tab;
    await tab.playwright.waitForLoadState?.({
      state: "domcontentloaded",
      timeoutMs: 30_000,
    });
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
      }))
    ).isAnswering;
  }

  async #clickSend(tab: IabTab): Promise<void> {
    const previousUrl = (await tab.url()) ?? "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const button = await findUniqueLocator(tab, "button", SEND_BUTTON_NAMES);
      if (!button) {
        if (attempt > 0 && await this.#submissionStarted(tab, previousUrl)) {
          return;
        }
        throw new CueLineError("SEND_BUTTON_MISSING", "Could not find ChatGPT's send button.");
      }
      try {
        await button.click({ timeoutMs: 10_000 });
        return;
      } catch (error) {
        if (await this.#submissionStarted(tab, previousUrl)) {
          return;
        }
        if (attempt === 1 || !isTransientClickError(error)) {
          throw error;
        }
        await tab.playwright.domSnapshot();
        await tab.playwright.waitForTimeout(250);
      }
    }
  }

  async #waitForCompletion(tab: IabTab, baseline: PageChatState): Promise<PageChatState> {
    const deadline = Date.now() + this.#options.timeoutMs;
    let stableText = "";
    let stableSince = 0;
    let responseStarted = false;
    while (Date.now() < deadline) {
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
      await delay(this.#options.pollIntervalMs);
    }
    throw new CueLineError("CHATGPT_RESPONSE_TIMEOUT", "ChatGPT did not finish before timeout.");
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
  ): Promise<ControllerTurn> {
    const tab = await this.#getTab();
    const composer =
      (await findHydratedComposer(tab)) ??
      (await findUniqueLocator(tab, "textbox", COMPOSER_TEXTBOX_NAMES));
    if (!composer) {
      throw new CueLineError("COMPOSER_MISSING", "Could not find ChatGPT's message composer.");
    }
    context.selectedModelLabel = await this.#ensureProModel(tab);
    context.baseline = await readPageChatState(tab);
    await composer.fill(input.prompt, {});
    context.stage = "submitting";
    await this.#clickSend(tab);
    context.stage = "submitted";
    const submittedUrl = (await tab.url().catch(() => "")) ?? "";
    if (isConversationUrl(submittedUrl)) this.#conversationUrl = submittedUrl;
    const completed = await this.#waitForCompletion(tab, context.baseline);
    return this.#resultFromCompletedTurn(tab, context.selectedModelLabel, completed);
  }

  async sendTurn(input: BrowserTurnInput): Promise<ControllerTurn> {
    const context: TurnAttemptContext = { stage: "pre_submit" };
    try {
      return await this.#sendTurnOnce(input, context);
    } catch (error) {
      if (!isTabUnavailableError(error)) throw error;
      if (this.#conversationUrl === undefined) {
        throw new CueLineError(
          "TAB_RECOVERY_UNSAFE",
          "The ChatGPT tab disappeared before CueLine captured an exact conversation URL; refusing a potentially duplicate send.",
          { cause: error },
        );
      }
      this.#tab = undefined;
      if (context.stage === "pre_submit") {
        const retryContext: TurnAttemptContext = { stage: "pre_submit" };
        return this.#sendTurnOnce(input, retryContext);
      }
      if (!context.baseline || !context.selectedModelLabel) throw error;
      const recoveredTab = await this.#getTab();
      const recoveredState = await readPageChatState(recoveredTab);
      const responseStarted =
        recoveredState.isAnswering ||
        recoveredState.assistantMessageCount > context.baseline.assistantMessageCount;
      if (context.stage === "submitting" && !responseStarted) {
        throw new CueLineError(
          "TAB_RECOVERY_UNSAFE",
          "The ChatGPT tab disappeared while submitting, and CueLine cannot prove whether the prompt was sent. Refusing a duplicate send.",
          { cause: error },
        );
      }
      const completed = await this.#waitForCompletion(recoveredTab, context.baseline);
      return this.#resultFromCompletedTurn(
        recoveredTab,
        context.selectedModelLabel,
        completed,
      );
    }
  }
}

export function createCodexIabAdapter(options: CodexIabAdapterOptions = {}): BrowserAdapter {
  return new CodexIabAdapter(options);
}
