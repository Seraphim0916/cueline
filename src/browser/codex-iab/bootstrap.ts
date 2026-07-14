import { CueLineError } from "../../core/errors.js";

export interface PageChatState {
  isAnswering: boolean;
  assistantText: string;
  assistantMessageCount: number;
}

export interface IabLocator {
  count(): Promise<number>;
  fill(value: string, options?: Record<string, unknown>): Promise<void>;
  click(options?: { timeoutMs?: number }): Promise<void>;
}

export interface IabPlaywright {
  getByRole(role: string, query: { name: string }): IabLocator;
  evaluate<Result, Argument = undefined>(
    pageFunction: (argument: Argument) => Result | Promise<Result>,
    argument?: Argument,
  ): Promise<Result>;
  domSnapshot(): Promise<unknown>;
  waitForTimeout(milliseconds: number): Promise<void>;
  waitForLoadState?(options: { state: string; timeoutMs: number }): Promise<void>;
}

export interface IabTab {
  id?: string;
  goto(url: string): Promise<void>;
  url(): Promise<string | undefined>;
  title?(): Promise<string>;
  playwright: IabPlaywright;
}

export interface IabOpenTab {
  id?: string;
  url?: string;
  title?: string;
}

export interface IabBrowser {
  documentation?(): Promise<unknown>;
  tabs: {
    new: () => Promise<IabTab>;
    selected?: () => Promise<IabTab | undefined>;
    list?: () => Promise<IabOpenTab[]>;
    get?: (id: string) => Promise<IabTab>;
  };
  user?: {
    openTabs?(): Promise<IabOpenTab[]>;
    claimTab?(tab: IabOpenTab): Promise<IabTab>;
  };
}

interface BrowserAgent {
  browsers?: {
    get?(type: string): Promise<IabBrowser>;
  };
}

declare global {
  // These globals are injected by the Codex browser runtime. They are absent in plain Node.
  var iab: IabBrowser | undefined;
  var agent: BrowserAgent | undefined;
}

export async function resolveIabBrowser(requested?: IabBrowser): Promise<IabBrowser> {
  if (requested) {
    await requested.documentation?.();
    return requested;
  }
  if (globalThis.iab) {
    await globalThis.iab.documentation?.();
    return globalThis.iab;
  }
  if (globalThis.agent?.browsers?.get) {
    const browser = await globalThis.agent.browsers.get("iab");
    await browser.documentation?.();
    globalThis.iab = browser;
    return browser;
  }
  throw new CueLineError(
    "IAB_BROWSER_MISSING",
    "Codex did not expose the in-app Browser runtime. Run CueLine from a Codex task with the built-in Browser available or inject an IabBrowser.",
  );
}

export async function readPageChatState(tab: IabTab): Promise<PageChatState> {
  return tab.playwright.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const isAnswering = buttons.some((button) => {
      const label = [button.getAttribute("aria-label"), button.textContent]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      return /stop/i.test(label) && /(answer|generat|respond|stream|thinking)/i.test(label);
    });

    const assistantMessages = Array.from(
      document.querySelectorAll('[data-message-author-role="assistant"]'),
    );
    const last = assistantMessages.at(-1);
    const visibleText =
      last !== undefined && "innerText" in last
        ? String((last as Element & { innerText?: string }).innerText ?? last.textContent ?? "")
        : last?.textContent ?? "";
    const assistantText = visibleText
      .replace(/\u00a0/g, " ")
      .trim();
    return { isAnswering, assistantText, assistantMessageCount: assistantMessages.length };
  });
}
