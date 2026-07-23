import type { BrowserSubmissionTargetEvidence } from "../browser-adapter.js";
import { CHATGPT_DELIVERY_TIMEOUT_MESSAGE } from "../delivery-timeout.js";
import type { IabTab } from "./bootstrap.js";

export type DeliveryTimeoutRetryCommitResult =
  | { status: "clicked" }
  | {
      status: "not_clicked";
      reason:
        | "response_started"
        | "conversation_changed"
        | "assistant_changed"
        | "composer_changed"
        | "target_changed"
        | "page_not_interactive";
    };

/**
 * Read-only target proof for the Retry button owned by the last timed-out
 * assistant turn. Historical or unrelated Retry buttons are never eligible.
 */
export async function inspectDeliveryTimeoutRetryButton(
  tab: IabTab,
): Promise<BrowserSubmissionTargetEvidence | undefined> {
  const inspected = await tab.playwright.evaluate<
    Omit<BrowserSubmissionTargetEvidence, "tabId" | "targetKind"> | null,
    { retryProbe: true; deliveryTimeoutMessage: string }
  >(
    ({ deliveryTimeoutMessage }) => {
      const normalize = (value: unknown): string =>
        String(value ?? "").replace(/\s+/g, " ").trim();
      const describeElement = (
        element: Element | null,
      ): BrowserSubmissionTargetEvidence["elementFromPoint"] =>
        element === null
          ? null
          : {
              tagName: element.tagName.toLowerCase(),
              role: element.getAttribute("role"),
              ariaLabel: element.getAttribute("aria-label"),
              testId: element.getAttribute("data-testid"),
              id: element.id || null,
              className:
                typeof element.className === "string"
                  ? element.className.slice(0, 256)
                  : null,
            };
      const visible = (button: HTMLButtonElement): boolean => {
        if (
          button.disabled ||
          button.hidden ||
          button.getAttribute("aria-disabled") === "true" ||
          button.getAttribute("aria-hidden") === "true" ||
          button.closest('[hidden], [aria-hidden="true"], [inert]') !== null
        ) return false;
        const style = getComputedStyle(button);
        const rect = button.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.visibility !== "collapse" &&
          style.pointerEvents !== "none" &&
          Number(style.opacity) !== 0 &&
          rect.width > 0 &&
          rect.height > 0 &&
          button.getClientRects().length > 0
        );
      };
      const assistants = Array.from(
        document.querySelectorAll('[data-message-author-role="assistant"]'),
      );
      const assistant = assistants.at(-1);
      if (assistant === undefined) return null;
      const text = normalize(
        "innerText" in assistant
          ? (assistant as Element & { innerText?: string }).innerText
          : assistant.textContent,
      );
      if (!text.includes(deliveryTimeoutMessage)) return null;
      const scope = assistant.closest("article") ?? assistant;
      const retryButtons = Array.from(scope.querySelectorAll("button")).filter(
        (button) =>
          /^retry$/i.test(normalize(button.getAttribute("aria-label") || button.textContent)) &&
          visible(button),
      );
      if (retryButtons.length !== 1) return null;
      const button = retryButtons[0]!;
      const rect = button.getBoundingClientRect();
      const coordinate = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
      const hit = document.elementFromPoint(coordinate.x, coordinate.y);
      const hitButton = hit?.closest("button") ?? null;
      let documentHasFocus: boolean | null = null;
      try {
        documentHasFocus = document.hasFocus();
      } catch {
        // The read-only browser sandbox may not expose focus state.
      }
      return {
        coordinate,
        buttonRect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          left: rect.left,
        },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        devicePixelRatio: window.devicePixelRatio,
        elementFromPoint: describeElement(hit),
        elementFromPointButtonAncestor: describeElement(hitButton),
        elementFromPointMatchesButton: hitButton === button,
        documentHasFocus,
        documentVisibilityState: document.visibilityState,
      };
    },
    { retryProbe: true, deliveryTimeoutMessage: CHATGPT_DELIVERY_TIMEOUT_MESSAGE },
  );
  if (inspected === null) return undefined;
  return {
    ...inspected,
    tabId: tab.id ?? null,
    targetKind: "coordinate",
  };
}

/**
 * Revalidates the complete no-resend guard and invokes the one Retry button in
 * the same page task. ChatGPT cannot interleave a response DOM update between
 * this final check and `button.click()`.
 */
export async function commitDeliveryTimeoutRetry(
  tab: IabTab,
  input: {
    expectedPageUrl: string;
    expectedAssistantText: string;
    expectedUserMessageCount: number;
    expectedAssistantMessageCount: number;
    expectedTarget: BrowserSubmissionTargetEvidence;
    sendButtonNames: readonly string[];
  },
): Promise<DeliveryTimeoutRetryCommitResult> {
  return tab.playwright.evaluate<
    DeliveryTimeoutRetryCommitResult,
    {
      retryCommit: true;
      deliveryTimeoutMessage: string;
      expectedPageUrl: string;
      expectedAssistantText: string;
      expectedUserMessageCount: number;
      expectedAssistantMessageCount: number;
      expectedTarget: BrowserSubmissionTargetEvidence;
      sendButtonNames: string[];
    }
  >(
    ({
      deliveryTimeoutMessage,
      expectedPageUrl,
      expectedAssistantText,
      expectedUserMessageCount,
      expectedAssistantMessageCount,
      expectedTarget,
      sendButtonNames,
    }) => {
      const normalize = (value: unknown): string =>
        String(value ?? "")
          .replace(/\u00a0/g, " ")
          .replace(/\r\n?/g, "\n")
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n(?:[ \t]*\n)+/g, "\n")
          .trim();
      const canonicalConversationUrl = (value: string): string | null => {
        try {
          const parsed = new URL(value);
          if (
            parsed.protocol !== "https:" ||
            parsed.hostname !== "chatgpt.com" ||
            parsed.username !== "" ||
            parsed.password !== "" ||
            !/^\/c\/[^/]+\/?$/.test(parsed.pathname)
          ) return null;
          return `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}`;
        } catch {
          return null;
        }
      };
      const visible = (element: HTMLElement): boolean => {
        if (
          element.hidden ||
          element.getAttribute("aria-hidden") === "true" ||
          element.closest('[hidden], [aria-hidden="true"], [inert]') !== null
        ) return false;
        const checkVisibility = (
          element as HTMLElement & {
            checkVisibility?: (options?: {
              checkOpacity?: boolean;
              checkVisibilityCSS?: boolean;
            }) => boolean;
          }
        ).checkVisibility;
        if (typeof checkVisibility === "function") {
          try {
            if (
              !checkVisibility.call(element, {
                checkOpacity: true,
                checkVisibilityCSS: true,
              })
            ) return false;
          } catch {
            // Explicit style and geometry checks below remain fail-closed.
          }
        }
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.visibility !== "collapse" &&
          style.pointerEvents !== "none" &&
          Number(style.opacity) !== 0 &&
          rect.width > 0 &&
          rect.height > 0 &&
          element.getClientRects().length > 0
        );
      };
      const currentUrl = canonicalConversationUrl(window.location.href);
      if (
        currentUrl === null ||
        currentUrl !== canonicalConversationUrl(expectedPageUrl)
      ) {
        return { status: "not_clicked", reason: "conversation_changed" };
      }
      if (
        document.visibilityState !== "visible" ||
        (typeof document.hasFocus === "function" && !document.hasFocus())
      ) {
        return { status: "not_clicked", reason: "page_not_interactive" };
      }
      const buttons = Array.from(document.querySelectorAll("button"));
      const isAnswering = buttons.some((element) => {
        const button = element as HTMLButtonElement;
        const label = normalize(
          button.getAttribute("aria-label") || button.textContent,
        );
        return (
          /(stop|停止|中止|중지|정지)/i.test(label) &&
          /(answer|generat|respond|response|stream|thinking|回答|回覆|作答|生成|產生|思考|応答|생성|답변|응답)/i.test(
            label,
          ) &&
          !button.disabled &&
          button.getAttribute("aria-disabled") !== "true" &&
          visible(button)
        );
      });
      if (isAnswering) {
        return { status: "not_clicked", reason: "response_started" };
      }
      const messages = Array.from(
        document.querySelectorAll("[data-message-author-role]"),
      );
      const assistants = messages.filter(
        (message) =>
          message.getAttribute("data-message-author-role") === "assistant",
      );
      const users = messages.filter(
        (message) => message.getAttribute("data-message-author-role") === "user",
      );
      const assistant = assistants.at(-1);
      const lastRole = messages.at(-1)?.getAttribute("data-message-author-role");
      const assistantText = normalize(
        assistant !== undefined && "innerText" in assistant
          ? (assistant as Element & { innerText?: string }).innerText
          : assistant?.textContent,
      );
      if (
        assistant === undefined ||
        lastRole !== "assistant" ||
        users.length !== expectedUserMessageCount ||
        assistants.length !== expectedAssistantMessageCount ||
        assistantText !== normalize(expectedAssistantText) ||
        !assistantText.includes(deliveryTimeoutMessage)
      ) {
        return { status: "not_clicked", reason: "assistant_changed" };
      }

      const composer = document.querySelector<HTMLElement>(
        '#prompt-textarea[contenteditable="true"]',
      );
      if (composer === null) {
        return { status: "not_clicked", reason: "composer_changed" };
      }
      const inlineText = normalize(composer.innerText);
      const composerRoot =
        composer.closest("form") ??
        composer.parentElement?.parentElement ??
        document;
      const attachmentElements = new Set<Element>();
      for (const element of Array.from(
        composerRoot.querySelectorAll(
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
          /(?:file-upload-preview|attachment.*preview|file.*preview)/i.test(
            testId,
          ) ||
          /(?:attachment|file).*(?:pill|chip)|(?:pill|chip).*(?:attachment|file)/i.test(
            classes,
          )
        ) attachmentElements.add(element);
      }
      const pastedTextAttachmentPresent = Array.from(
        composerRoot.querySelectorAll('button[aria-label]'),
      ).some(
        (element) =>
          normalize(element.getAttribute("aria-label")) ===
          "Open pasted text attachment. Too long to show in text field",
      );
      const sendButtonEnabled = Array.from(
        composerRoot.querySelectorAll("button"),
      ).some((element) => {
        const button = element as HTMLButtonElement;
        const label = normalize(
          button.getAttribute("aria-label") ??
            button.innerText ??
            button.textContent,
        );
        return (
          sendButtonNames.includes(label) &&
          !button.disabled &&
          button.getAttribute("aria-disabled") !== "true" &&
          visible(button)
        );
      });
      if (
        inlineText !== "" ||
        attachmentElements.size !== 0 ||
        pastedTextAttachmentPresent ||
        sendButtonEnabled
      ) {
        return { status: "not_clicked", reason: "composer_changed" };
      }

      const scope = assistant.closest("article") ?? assistant;
      const retryButtons = Array.from(scope.querySelectorAll("button")).filter(
        (element) => {
          const button = element as HTMLButtonElement;
          return (
            /^retry$/i.test(
              normalize(button.getAttribute("aria-label") || button.textContent),
            ) &&
            !button.disabled &&
            button.getAttribute("aria-disabled") !== "true" &&
            visible(button)
          );
        },
      );
      if (retryButtons.length !== 1) {
        return { status: "not_clicked", reason: "target_changed" };
      }
      const button = retryButtons[0] as HTMLButtonElement;
      const rect = button.getBoundingClientRect();
      const coordinate = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
      const hitButton = document
        .elementFromPoint(coordinate.x, coordinate.y)
        ?.closest("button");
      const expectedRect = expectedTarget.buttonRect;
      if (
        expectedTarget.targetKind !== "coordinate" ||
        expectedTarget.elementFromPointMatchesButton !== true ||
        coordinate.x !== expectedTarget.coordinate.x ||
        coordinate.y !== expectedTarget.coordinate.y ||
        rect.x !== expectedRect.x ||
        rect.y !== expectedRect.y ||
        rect.width !== expectedRect.width ||
        rect.height !== expectedRect.height ||
        rect.top !== expectedRect.top ||
        rect.right !== expectedRect.right ||
        rect.bottom !== expectedRect.bottom ||
        rect.left !== expectedRect.left ||
        window.innerWidth !== expectedTarget.viewport.width ||
        window.innerHeight !== expectedTarget.viewport.height ||
        window.devicePixelRatio !== expectedTarget.devicePixelRatio ||
        hitButton !== button ||
        !button.isConnected
      ) {
        return { status: "not_clicked", reason: "target_changed" };
      }

      button.click();
      return { status: "clicked" };
    },
    {
      retryCommit: true,
      deliveryTimeoutMessage: CHATGPT_DELIVERY_TIMEOUT_MESSAGE,
      expectedPageUrl: input.expectedPageUrl,
      expectedAssistantText: input.expectedAssistantText,
      expectedUserMessageCount: input.expectedUserMessageCount,
      expectedAssistantMessageCount: input.expectedAssistantMessageCount,
      expectedTarget: input.expectedTarget,
      sendButtonNames: [...input.sendButtonNames],
    },
  );
}
