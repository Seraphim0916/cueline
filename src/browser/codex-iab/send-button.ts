import type { IabTab } from "./bootstrap.js";
import type { BrowserSubmissionTargetEvidence } from "../browser-adapter.js";
import { SEND_BUTTON_NAMES } from "./selectors.js";

export type VisibleSendButtonEvidence = Omit<
  BrowserSubmissionTargetEvidence,
  "targetKind"
>;

export async function inspectVisibleSendButton(
  tab: IabTab,
): Promise<VisibleSendButtonEvidence | undefined> {
  const target = await tab.playwright.evaluate(
    ({ sendButtonNames }) => {
      const normalize = (value: unknown): string =>
        String(value ?? "").trim().replace(/\s+/g, " ");
      const describeElement = (element: Element | null) => {
        if (element === null) return null;
        const className =
          typeof (element as HTMLElement).className === "string"
            ? (element as HTMLElement).className.slice(0, 500)
            : null;
        const bounded = (value: string | null): string | null =>
          value === null ? null : value.slice(0, 500);
        return {
          tagName: element.tagName.toLowerCase(),
          role: bounded(element.getAttribute("role")),
          ariaLabel: bounded(element.getAttribute("aria-label")),
          testId: bounded(element.getAttribute("data-testid")),
          id: bounded(element.getAttribute("id")),
          className,
        };
      };
      const candidates = Array.from(document.querySelectorAll("button")).filter((element) => {
        const button = element as HTMLButtonElement;
        const style = window.getComputedStyle(button);
        const rect = button.getBoundingClientRect();
        const label = normalize(
          button.getAttribute("aria-label") ?? button.innerText ?? button.textContent,
        );
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
        return (
          sendButtonNames.some((name) => name === label) &&
          !button.disabled &&
          !button.hidden &&
          button.getAttribute("aria-disabled") !== "true" &&
          button.getAttribute("aria-hidden") !== "true" &&
          button.closest('[hidden], [aria-hidden="true"], [inert]') === null &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.visibility !== "collapse" &&
          style.pointerEvents !== "none" &&
          Number(style.opacity) !== 0 &&
          rect.width > 0 &&
          rect.height > 0 &&
          button.getClientRects().length > 0 &&
          rect.right > 0 &&
          rect.bottom > 0 &&
          rect.left < window.innerWidth &&
          rect.top < window.innerHeight
        );
      });
      if (candidates.length !== 1) return null;
      const button = candidates[0]!;
      const rect = button.getBoundingClientRect();
      // The persisted hit-test evidence must describe the exact coordinate
      // handed to CUA, including the legacy integer rounding contract.
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      const hit = document.elementFromPoint(x, y);
      const hitButton = hit?.closest("button") ?? null;
      return {
        coordinate: { x, y },
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
        elementFromPointMatchesButton:
          hit === button || button.contains(hit) || hitButton === button,
        documentHasFocus:
          typeof document.hasFocus === "function" ? document.hasFocus() : null,
        documentVisibilityState: document.visibilityState,
      };
    },
    { sendButtonNames: [...SEND_BUTTON_NAMES] },
  ).catch(() => null);
  const numericValues =
    target === null
      ? []
      : [
          target.coordinate.x,
          target.coordinate.y,
          target.buttonRect.x,
          target.buttonRect.y,
          target.buttonRect.width,
          target.buttonRect.height,
          target.buttonRect.top,
          target.buttonRect.right,
          target.buttonRect.bottom,
          target.buttonRect.left,
          target.viewport.width,
          target.viewport.height,
          target.devicePixelRatio,
        ];
  if (
    target === null ||
    numericValues.some((value) => !Number.isFinite(value)) ||
    target.coordinate.x < 0 ||
    target.coordinate.y < 0 ||
    target.buttonRect.width <= 0 ||
    target.buttonRect.height <= 0 ||
    target.viewport.width <= 0 ||
    target.viewport.height <= 0 ||
    target.devicePixelRatio <= 0
  ) {
    return undefined;
  }
  return {
    tabId: tab.id ?? null,
    coordinate: target.coordinate,
    buttonRect: target.buttonRect,
    viewport: target.viewport,
    devicePixelRatio: target.devicePixelRatio,
    elementFromPoint: target.elementFromPoint,
    elementFromPointButtonAncestor: target.elementFromPointButtonAncestor,
    elementFromPointMatchesButton: target.elementFromPointMatchesButton,
    documentHasFocus: target.documentHasFocus,
    documentVisibilityState: target.documentVisibilityState,
  };
}

export async function findVisibleSendButtonCoordinates(
  tab: IabTab,
): Promise<{ x: number; y: number } | undefined> {
  if (!tab.cua?.click) return undefined;
  return (await inspectVisibleSendButton(tab))?.coordinate;
}
