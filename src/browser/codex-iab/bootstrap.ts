import { CueLineError } from "../../core/errors.js";
import type { ExpectedControllerIdentity } from "../../protocol/types.js";
import type { ComposerPromptState } from "../browser-adapter.js";
import { exactAccessibilityControllerEnvelopeText } from "./recovery-evidence.js";

export interface PageChatState {
  /** URL captured with DOM evidence; accessibility recovery rechecks it before adoption. */
  pageUrl: string;
  isAnswering: boolean;
  assistantText: string;
  userMessageCount?: number;
  assistantMessageCount: number;
  assistantModelSlug: string | null;
  lastUserText: string | null;
  lastMessageRole: "assistant" | "user" | null;
  assistantTextSource?: "message_dom" | "accessibility_exact_envelope";
  assistantTextFoundBy?: "last_message" | "exact_envelope_scan" | "accessibility_exact_envelope";
  requestMessageFound?: boolean | null;
  requestMessageFoundBy?: "last_text" | "request_id_scan" | "prompt_scan" | null;
  requestMessageScanComplete?: boolean;
}

export interface PageComposerState {
  state: ComposerPromptState | "empty";
  inlineTextLength: number;
  attachmentCount: number;
  pastedTextAttachmentPresent?: boolean;
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
  isVisible?(): Promise<boolean>;
  isEnabled?(): Promise<boolean>;
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

function codexTurnSessionId(): string | undefined {
  const sessionId =
    globalThis.nodeRepl?.requestMeta?.["x-codex-turn-metadata"]?.session_id;
  return typeof sessionId === "string" && sessionId.length > 0
    ? sessionId
    : undefined;
}

function iabBackendNotRegisteredError(cause: unknown): CueLineError {
  const turnMetadataPresent = codexTurnSessionId() !== undefined;
  return new CueLineError(
    "IAB_BACKEND_NOT_REGISTERED",
    "Codex browser runtime is initialized, but no in-app Browser backend is registered for this Codex session.",
    {
      cause,
      details: {
        turn_metadata_present: turnMetadataPresent,
        probable_reason: turnMetadataPresent
          ? "no-session-match"
          : "missing-session-metadata",
        recovery:
          "從目前 Codex session 重開 IAB 面板後重試 continue;不得重送 prompt、不得開新對話",
      },
    },
  );
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
    let browser: IabBrowser;
    try {
      browser = await globalThis.agent.browsers.get("iab");
    } catch (error) {
      throw iabBackendNotRegisteredError(error);
    }
    await browser.documentation?.();
    globalThis.iab = browser;
    return browser;
  }
  throw new CueLineError(
    "IAB_BROWSER_MISSING",
    "Codex did not expose the in-app Browser runtime. Run CueLine from a Codex task with the built-in Browser available or inject an IabBrowser.",
  );
}

export async function readPageChatState(
  tab: IabTab,
  exactControllerIdentity?: ExpectedControllerIdentity,
  expectedPrompt?: string,
): Promise<PageChatState> {
  const state = await tab.playwright.evaluate<
    PageChatState,
    {
      allowCountDegradedModelEvidence: boolean;
      exactControllerIdentity?: ExpectedControllerIdentity;
      expectedPrompt?: string;
    }
  >(
    (
      { allowCountDegradedModelEvidence, exactControllerIdentity, expectedPrompt } = {
        allowCountDegradedModelEvidence: false,
      },
    ) => {
      const normalizeMessageText = (value: unknown): string =>
        String(value ?? "")
          .replace(/\u00a0/g, " ")
          .replace(/\r\n?/g, "\n")
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n(?:[ \t]*\n)+/g, "\n")
          .trim();
      const visibleMessageText = (message: Element | undefined): string =>
        message !== undefined && "innerText" in message
          ? String(
              (message as Element & { innerText?: string }).innerText ??
                message.textContent ??
                "",
            )
          : message?.textContent ?? "";
      const hasExactIdentity = (text: string): boolean => {
        if (exactControllerIdentity === undefined) return false;
        let body: string | undefined;
        for (const match of text.matchAll(/<CueLineControl>([\s\S]*?)<\/CueLineControl>/g)) {
          body = match[1];
        }
        if (body === undefined) return false;
        try {
          const parsed = JSON.parse(body.trim()) as Record<string, unknown>;
          return (
            parsed.protocol === "cueline/0.1" &&
            parsed.run_id === exactControllerIdentity.runId &&
            parsed.round === exactControllerIdentity.round &&
            parsed.request_id === exactControllerIdentity.requestId
          );
        } catch {
          return false;
        }
      };
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
      const lastAssistant = assistantMessages.at(-1);
      const exactAssistant = assistantMessages.findLast((message) =>
        hasExactIdentity(normalizeMessageText(visibleMessageText(message))),
      );
      const selectedAssistant = exactAssistant ?? lastAssistant;
      const assistantText = normalizeMessageText(visibleMessageText(selectedAssistant));
      const modelTaggedMessages = Array.from(
        document.querySelectorAll("[data-message-model-slug]"),
      );
      const assistantModelSlug =
        selectedAssistant?.getAttribute("data-message-model-slug") ??
        (allowCountDegradedModelEvidence
          ? modelTaggedMessages.at(-1)?.getAttribute("data-message-model-slug")
          : null) ??
        null;
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
        lastUser === undefined ? null : normalizeMessageText(lastUserVisibleText);
      const normalizedExpectedPrompt = normalizeMessageText(expectedPrompt);
      const lastUserMatches =
        exactControllerIdentity !== undefined &&
        lastUserText !== null &&
        (lastUserText.includes(exactControllerIdentity.requestId) ||
          (normalizedExpectedPrompt !== "" &&
            normalizeMessageText(lastUserText) === normalizedExpectedPrompt));
      const requestIdMatch =
        exactControllerIdentity !== undefined &&
        userMessages.some((message) =>
          normalizeMessageText(visibleMessageText(message)).includes(
            exactControllerIdentity.requestId,
          ),
        );
      const promptMatch =
        normalizedExpectedPrompt !== "" &&
        userMessages.some(
          (message) =>
            normalizeMessageText(visibleMessageText(message)) === normalizedExpectedPrompt,
        );
      const requestMessageFoundBy: PageChatState["requestMessageFoundBy"] =
        exactControllerIdentity === undefined && normalizedExpectedPrompt === ""
          ? null
          : lastUserMatches
            ? "last_text"
            : requestIdMatch
              ? "request_id_scan"
              : promptMatch
                ? "prompt_scan"
                : null;
      const lastRole = messages.at(-1)?.getAttribute("data-message-author-role");
      const lastMessageRole: PageChatState["lastMessageRole"] =
        lastRole === "assistant" || lastRole === "user" ? lastRole : null;
      return {
        pageUrl: window.location.href,
        isAnswering,
        assistantText,
        userMessageCount: userMessages.length,
        assistantMessageCount: assistantMessages.length,
        assistantModelSlug,
        lastUserText,
        lastMessageRole,
        assistantTextSource: "message_dom" as const,
        assistantTextFoundBy:
          exactAssistant === undefined ? "last_message" : "exact_envelope_scan",
        requestMessageFound:
          exactControllerIdentity === undefined && normalizedExpectedPrompt === ""
            ? null
            : requestMessageFoundBy !== null,
        requestMessageFoundBy,
        requestMessageScanComplete:
          exactControllerIdentity !== undefined || normalizedExpectedPrompt !== "",
      };
    },
    {
      allowCountDegradedModelEvidence: exactControllerIdentity !== undefined,
      ...(exactControllerIdentity === undefined ? {} : { exactControllerIdentity }),
      ...(expectedPrompt === undefined ? {} : { expectedPrompt }),
    },
  );

  if (
    exactControllerIdentity === undefined ||
    state.assistantMessageCount > 0 ||
    state.assistantText !== ""
  ) {
    return state;
  }

  const snapshot = await tab.playwright.domSnapshot();
  if (typeof snapshot !== "string") return state;
  const exactEnvelope = exactAccessibilityControllerEnvelopeText(
    snapshot,
    exactControllerIdentity,
  );
  if (exactEnvelope === null) return state;

  return {
    ...state,
    assistantText: exactEnvelope,
    lastMessageRole: "assistant",
    assistantTextSource: "accessibility_exact_envelope",
    assistantTextFoundBy: "accessibility_exact_envelope",
  };
}

export async function readAccessibilityRequestIdPresence(
  tab: IabTab,
  requestId: string,
): Promise<boolean | null> {
  const snapshot = await tab.playwright.domSnapshot();
  return typeof snapshot === "string" ? snapshot.includes(requestId) : null;
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
      const pastedTextAttachmentPresent = Array.from(
        root.querySelectorAll('button[aria-label]'),
      ).some(
        (element) =>
          normalize(element.getAttribute("aria-label")) ===
          "Open pasted text attachment. Too long to show in text field",
      );
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
        pastedTextAttachmentPresent,
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
