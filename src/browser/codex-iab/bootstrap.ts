import { CueLineError } from "../../core/errors.js";
import type { ComposerPromptState } from "../browser-adapter.js";

export interface PageChatState {
  /** URL captured in the same DOM evaluation as the response evidence. */
  pageUrl: string;
  isAnswering: boolean;
  assistantText: string;
  assistantMessageCount: number;
  assistantModelSlug: string | null;
  lastUserText: string | null;
  lastMessageRole: "assistant" | "user" | null;
}

export interface PageComposerState {
  state: ComposerPromptState | "empty";
  inlineTextLength: number;
  attachmentCount: number;
  sendButtonEnabled: boolean;
}

export interface PageProbeState {
  pageUrl: string;
  isAnswering: boolean;
  assistantMessageCount: number;
  lastMessageRole: "assistant" | "user" | null;
  assistantModelSlug: string | null;
  selectedModelLabel: string | null;
  modelLabelCount: number;
  composerState: "missing" | "empty" | "inline_present" | "attachment_ready";
  inlineTextLength: number;
  attachmentCount: number;
  sendButtonState: "missing" | "disabled" | "enabled" | "ambiguous";
}

export interface IabLocator {
  count(): Promise<number>;
  fill(value: string, options?: Record<string, unknown>): Promise<void>;
  click(options?: { timeoutMs?: number }): Promise<void>;
  waitFor?(options: { state: "visible"; timeoutMs: number }): Promise<void>;
}

export interface IabPlaywright {
  getByRole(role: string, query: { name: string }): IabLocator;
  locator?(selector: string): IabLocator;
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
  cua?: {
    click(options: { x: number; y: number }): Promise<void>;
  };
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
  var browser: IabBrowser | undefined;
  var iab: IabBrowser | undefined;
  var agent: BrowserAgent | undefined;
}

export async function resolveIabBrowser(requested?: IabBrowser): Promise<IabBrowser> {
  if (requested) {
    await requested.documentation?.();
    return requested;
  }
  if (globalThis.browser) {
    await globalThis.browser.documentation?.();
    globalThis.iab = globalThis.browser;
    return globalThis.browser;
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
      const ariaLabel = button.getAttribute("aria-label")?.trim();
      const label = (ariaLabel || button.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      if (
        !/(stop|停止|中止|중지|정지)/i.test(label) ||
        !/(answer|generat|respond|response|stream|thinking|回答|回覆|作答|生成|產生|思考|応答|생성|답변|응답)/i.test(
          label,
        )
      ) {
        return false;
      }
      if (
        button.disabled ||
        button.hidden ||
        button.getAttribute("aria-disabled") === "true" ||
        button.getAttribute("aria-hidden") === "true" ||
        button.closest('[hidden], [aria-hidden="true"], [inert]') !== null
      ) {
        return false;
      }
      const checkVisibility = (
        button as HTMLButtonElement & {
          checkVisibility?: (options?: {
            checkOpacity?: boolean;
            checkVisibilityCSS?: boolean;
          }) => boolean;
        }
      ).checkVisibility;
      if (typeof checkVisibility === "function") {
        try {
          if (
            !checkVisibility.call(button, {
              checkOpacity: true,
              checkVisibilityCSS: true,
            })
          ) {
            return false;
          }
        } catch {
          // Older browser bindings may expose checkVisibility without option support.
          // The explicit style and geometry checks below remain the safe fallback.
        }
      }
      const style = getComputedStyle(button);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.pointerEvents === "none" ||
        Number(style.opacity) === 0
      ) {
        return false;
      }
      const bounds = button.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0 && button.getClientRects().length > 0;
    });

    const messages = Array.from(document.querySelectorAll("[data-message-author-role]"));
    const assistantMessages = messages.filter(
      (message) => message.getAttribute("data-message-author-role") === "assistant",
    );
    const userMessages = messages.filter(
      (message) => message.getAttribute("data-message-author-role") === "user",
    );
    const last = assistantMessages.at(-1);
    const visibleText =
      last !== undefined && "innerText" in last
        ? String((last as Element & { innerText?: string }).innerText ?? last.textContent ?? "")
        : last?.textContent ?? "";
    const assistantText = visibleText
      .replace(/\u00a0/g, " ")
      .trim();
    const assistantModelSlug = last?.getAttribute("data-message-model-slug") ?? null;
    const lastUser = userMessages.at(-1);
    const lastUserVisibleText =
      lastUser !== undefined && "innerText" in lastUser
        ? String(
            (lastUser as Element & { innerText?: string }).innerText ??
              lastUser.textContent ??
              "",
          )
        : lastUser?.textContent ?? "";
    const lastUserText =
      lastUser === undefined ? null : lastUserVisibleText.replace(/\u00a0/g, " ").trim();
    const lastRole = messages.at(-1)?.getAttribute("data-message-author-role");
    const lastMessageRole =
      lastRole === "assistant" || lastRole === "user" ? lastRole : null;
    return {
      pageUrl: window.location.href,
      isAnswering,
      assistantText,
      assistantMessageCount: assistantMessages.length,
      assistantModelSlug,
      lastUserText,
      lastMessageRole,
    };
  });
}

export async function readPageComposerState(
  tab: IabTab,
  expectedPrompt: string,
  sendButtonNames: readonly string[],
): Promise<PageComposerState> {
  return tab.playwright.evaluate(
    ({ composerProbe: _composerProbe, expectedPrompt, sendButtonNames }) => {
      const normalize = (value: unknown): string =>
        String(value ?? "")
          .replace(/\u00a0/g, " ")
          .replace(/\r\n?/g, "\n")
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n(?:[ \t]*\n)+/g, "\n")
          .trim();
      const composer = document.querySelector('#prompt-textarea[contenteditable="true"]');
      const inlineText = normalize(
        composer && "innerText" in composer
          ? (composer as HTMLElement).innerText
          : composer?.textContent,
      );
      const expected = normalize(expectedPrompt);
      const root = composer?.closest("form") ?? composer?.parentElement?.parentElement ?? document;
      const attachmentElements = new Set<Element>();
      for (const element of Array.from(
        root.querySelectorAll(
          '[data-testid="file-upload-preview"], [data-testid*="attachment"][data-testid*="preview"], [data-testid*="file"][data-testid*="preview"], [class*="attachment"][class*="pill"], [class*="file"][class*="pill"], button[aria-label]',
        ),
      )) {
        const label = normalize(element.getAttribute("aria-label"));
        const testId = normalize(element.getAttribute("data-testid"));
        const classes = normalize(element.getAttribute("class"));
        const isAttachment =
          /(?:remove|delete).*(?:file|attachment)|(?:file|attachment).*(?:remove|delete)|移除.*(?:檔案|附件)|刪除.*(?:檔案|附件)/i.test(
            label,
          ) ||
          /(?:file-upload-preview|attachment.*preview|file.*preview)/i.test(testId) ||
          /(?:attachment|file).*(?:pill|chip)|(?:pill|chip).*(?:attachment|file)/i.test(classes);
        if (isAttachment) attachmentElements.add(element);
      }
      const sendButtonEnabled = Array.from(root.querySelectorAll("button")).some((element) => {
        const button = element as HTMLButtonElement;
        const label = normalize(
          button.getAttribute("aria-label") ?? button.innerText ?? button.textContent,
        );
        const hiddenAncestor =
          typeof button.closest === "function" &&
          button.closest('[hidden], [aria-hidden="true"], [inert]') !== null;
        if (
          !sendButtonNames.includes(label) ||
          button.disabled ||
          button.hidden ||
          button.getAttribute("aria-disabled") === "true" ||
          button.getAttribute("aria-hidden") === "true" ||
          hiddenAncestor
        ) {
          return false;
        }
        const checkVisibility = (
          button as HTMLButtonElement & {
            checkVisibility?: (options?: {
              checkOpacity?: boolean;
              checkVisibilityCSS?: boolean;
            }) => boolean;
          }
        ).checkVisibility;
        if (typeof checkVisibility === "function") {
          try {
            if (
              !checkVisibility.call(button, {
                checkOpacity: true,
                checkVisibilityCSS: true,
              })
            ) {
              return false;
            }
          } catch {
            // Explicit style and geometry checks below remain the fallback.
          }
        }
        if (typeof getComputedStyle === "function") {
          const style = getComputedStyle(button);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.visibility === "collapse" ||
            style.pointerEvents === "none" ||
            Number(style.opacity) === 0
          ) {
            return false;
          }
        }
        if (typeof button.getBoundingClientRect === "function") {
          const bounds = button.getBoundingClientRect();
          if (bounds.width <= 0 || bounds.height <= 0) return false;
        }
        return typeof button.getClientRects !== "function" || button.getClientRects().length > 0;
      });
      const attachmentCount = attachmentElements.size;
      const state: PageComposerState["state"] =
        inlineText !== "" && inlineText === expected
          ? "inline_ready"
          : attachmentCount > 0
            ? "attachment_ready"
            : "empty";
      return {
        state,
        inlineTextLength: inlineText.length,
        attachmentCount,
        sendButtonEnabled,
      };
    },
    {
      composerProbe: true,
      expectedPrompt,
      sendButtonNames: [...sendButtonNames],
    },
  );
}

/**
 * Read a redacted diagnostic snapshot. This evaluator intentionally returns no
 * prompt text, message text, attachment names, cookies, or storage values.
 */
export async function readPageProbeState(tab: IabTab): Promise<PageProbeState> {
  return tab.playwright.evaluate(
    ({ diagnosticProbe: _diagnosticProbe }) => {
      const normalize = (value: unknown): string =>
        String(value ?? "")
          .replace(/\u00a0/g, " ")
          .replace(/\r\n?/g, "\n")
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n(?:[ \t]*\n)+/g, "\n")
          .trim();
      const isVisible = (element: Element): boolean => {
        const htmlElement = element as HTMLElement & {
          checkVisibility?: (options?: {
            checkOpacity?: boolean;
            checkVisibilityCSS?: boolean;
          }) => boolean;
        };
        if (
          htmlElement.hidden ||
          element.getAttribute("aria-hidden") === "true" ||
          element.closest('[hidden], [aria-hidden="true"], [inert]') !== null
        ) {
          return false;
        }
        if (typeof htmlElement.checkVisibility === "function") {
          try {
            if (
              !htmlElement.checkVisibility({
                checkOpacity: true,
                checkVisibilityCSS: true,
              })
            ) {
              return false;
            }
          } catch {
            // Fall through to explicit style and geometry checks.
          }
        }
        const style = getComputedStyle(element);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          style.pointerEvents === "none" ||
          Number(style.opacity) === 0
        ) {
          return false;
        }
        const bounds = element.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0 && element.getClientRects().length > 0;
      };
      const buttons = Array.from(document.querySelectorAll("button"));
      const isAnswering = buttons.some((element) => {
        const button = element as HTMLButtonElement;
        const ariaLabel = normalize(button.getAttribute("aria-label"));
        const label = ariaLabel || normalize(button.textContent);
        return (
          /(stop|停止|中止|중지|정지)/i.test(label) &&
          /(answer|generat|respond|response|stream|thinking|回答|回覆|作答|生成|產生|思考|応答|생성|답변|응답)/i.test(
            label,
          ) &&
          !button.disabled &&
          button.getAttribute("aria-disabled") !== "true" &&
          isVisible(button)
        );
      });

      const messages = Array.from(document.querySelectorAll("[data-message-author-role]"));
      const assistantMessages = messages.filter(
        (message) => message.getAttribute("data-message-author-role") === "assistant",
      );
      const lastRole = messages.at(-1)?.getAttribute("data-message-author-role");
      const lastMessageRole =
        lastRole === "assistant" || lastRole === "user" ? lastRole : null;
      const assistantModelSlug =
        assistantMessages.at(-1)?.getAttribute("data-message-model-slug") ?? null;

      const knownModel = /^(?:Instant(?:\s+\d+(?:\.\d+)*)?|Medium|High|Extra High|Thinking|Auto|Pro(?:\s+(?:Standard|Extended))?)$/i;
      const modelLabels = Array.from(document.querySelectorAll("button.__composer-pill"))
        .filter(isVisible)
        .map((element) =>
          normalize(
            element.getAttribute("aria-label") ??
              (element as HTMLElement).innerText ??
              element.textContent,
          ),
        )
        .filter((label) => knownModel.test(label));
      const selectedModelLabel = modelLabels.length === 1 ? modelLabels[0]! : null;

      const composer = document.querySelector('#prompt-textarea[contenteditable="true"]');
      const inlineText = normalize(
        composer && "innerText" in composer
          ? (composer as HTMLElement).innerText
          : composer?.textContent,
      );
      const root = composer?.closest("form") ?? composer?.parentElement?.parentElement ?? document;
      const attachmentElements = new Set<Element>();
      for (const element of Array.from(
        root.querySelectorAll(
          '[data-testid="file-upload-preview"], [data-testid*="attachment"][data-testid*="preview"], [data-testid*="file"][data-testid*="preview"], [class*="attachment"][class*="pill"], [class*="file"][class*="pill"], button[aria-label]',
        ),
      )) {
        const label = normalize(element.getAttribute("aria-label"));
        const testId = normalize(element.getAttribute("data-testid"));
        const classes = normalize(element.getAttribute("class"));
        if (
          /(?:remove|delete).*(?:file|attachment)|(?:file|attachment).*(?:remove|delete)|移除.*(?:檔案|附件)|刪除.*(?:檔案|附件)/i.test(
            label,
          ) ||
          /(?:file-upload-preview|attachment.*preview|file.*preview)/i.test(testId) ||
          /(?:attachment|file).*(?:pill|chip)|(?:pill|chip).*(?:attachment|file)/i.test(classes)
        ) {
          attachmentElements.add(element);
        }
      }
      const attachmentCount = attachmentElements.size;
      const composerState: PageProbeState["composerState"] =
        composer === null
          ? "missing"
          : attachmentCount > 0
            ? "attachment_ready"
            : inlineText.length > 0
              ? "inline_present"
              : "empty";

      const sendButtonNames = new Set([
        "Send prompt",
        "Send message",
        "傳送提示",
        "傳送訊息",
        "送出提示",
        "送出訊息",
      ]);
      const sendButtons = Array.from(root.querySelectorAll("button")).filter((element) => {
        const label = normalize(
          element.getAttribute("aria-label") ??
            (element as HTMLElement).innerText ??
            element.textContent,
        );
        return sendButtonNames.has(label) && isVisible(element);
      }) as HTMLButtonElement[];
      const sendButtonState: PageProbeState["sendButtonState"] =
        sendButtons.length === 0
          ? "missing"
          : sendButtons.length > 1
            ? "ambiguous"
            : sendButtons[0]!.disabled || sendButtons[0]!.getAttribute("aria-disabled") === "true"
              ? "disabled"
              : "enabled";

      return {
        pageUrl: window.location.href,
        isAnswering,
        assistantMessageCount: assistantMessages.length,
        lastMessageRole,
        assistantModelSlug,
        selectedModelLabel,
        modelLabelCount: modelLabels.length,
        composerState,
        inlineTextLength: inlineText.length,
        attachmentCount,
        sendButtonState,
      };
    },
    { diagnosticProbe: true },
  );
}
