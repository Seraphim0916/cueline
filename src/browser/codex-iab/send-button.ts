import type { IabTab } from "./bootstrap.js";
import { SEND_BUTTON_NAMES } from "./selectors.js";

export async function findVisibleSendButtonCoordinates(
  tab: IabTab,
): Promise<{ x: number; y: number } | undefined> {
  if (!tab.cua?.click) return undefined;
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
    return undefined;
  }
  return { x: Math.round(target.x), y: Math.round(target.y) };
}
