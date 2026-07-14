import type {
  BrowserAdapter,
  BrowserTurnInput,
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

function isConversationUrl(url: string): boolean {
  return /^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+/.test(url);
}

function isTransientClickError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /deadline exceeded|timed? out|timeout|detached|stale|not enabled|not visible/i.test(message);
}

class CodexIabAdapter implements BrowserAdapter {
  readonly #options: Required<Pick<CodexIabAdapterOptions, "timeoutMs" | "pollIntervalMs" | "stableMs">> &
    Pick<CodexIabAdapterOptions, "browser" | "conversationUrl">;
  #browser: IabBrowser | undefined;
  #tab: IabTab | undefined;

  constructor(options: CodexIabAdapterOptions) {
    this.#options = {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      stableMs: options.stableMs ?? DEFAULT_STABLE_MS,
      ...(options.browser === undefined ? {} : { browser: options.browser }),
      ...(options.conversationUrl === undefined ? {} : { conversationUrl: options.conversationUrl }),
    };
  }

  async #getBrowser(): Promise<IabBrowser> {
    this.#browser ??= await resolveIabBrowser(this.#options.browser);
    return this.#browser;
  }

  async #getTab(): Promise<IabTab> {
    if (this.#tab) return this.#tab;
    const browser = await this.#getBrowser();
    const targetUrl = this.#options.conversationUrl;
    const matchesTarget = (url: string): boolean =>
      targetUrl ? url === targetUrl : url.startsWith(CHATGPT_URL);
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

  async #waitForCompletion(tab: IabTab, baseline: PageChatState): Promise<string> {
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
          return stableText;
        }
      } else {
        stableText = state.assistantText;
        stableSince = Date.now();
      }
      await delay(this.#options.pollIntervalMs);
    }
    throw new CueLineError("CHATGPT_RESPONSE_TIMEOUT", "ChatGPT did not finish before timeout.");
  }

  async sendTurn(input: BrowserTurnInput): Promise<ControllerTurn> {
    const tab = await this.#getTab();
    const baseline = await readPageChatState(tab);
    const composer = await findUniqueLocator(tab, "textbox", COMPOSER_TEXTBOX_NAMES);
    if (!composer) {
      throw new CueLineError("COMPOSER_MISSING", "Could not find ChatGPT's message composer.");
    }
    await composer.fill(input.prompt, {});
    await this.#clickSend(tab);
    const text = await this.#waitForCompletion(tab, baseline);
    const conversationUrl = (await tab.url()) ?? "";
    const title = await tab.title?.();
    return {
      text,
      ...(conversationUrl === "" ? {} : { conversationUrl }),
      ...(title === undefined || title === "" ? {} : { title }),
    };
  }
}

export function createCodexIabAdapter(options: CodexIabAdapterOptions = {}): BrowserAdapter {
  return new CodexIabAdapter(options);
}
