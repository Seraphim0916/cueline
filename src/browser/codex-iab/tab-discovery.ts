import type { IabBrowser, IabTab } from "./bootstrap.js";
import { sameChatGptConversationUrl } from "../../core/conversation-url.js";
import { CHATGPT_URL } from "./selectors.js";

const TAB_DISCOVERY_RETRY_MS = 100;

export function isTabUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /tab not found|existing tabs: none|webview.*attach|cdp operation exceeded|target closed|page closed|browser.*disconnected/i.test(
    message,
  );
}

export async function acquireChatGptTab(
  browser: IabBrowser,
  conversationUrl?: string,
): Promise<IabTab> {
  const matchesTarget = (url: string): boolean =>
    conversationUrl === undefined
      ? url.startsWith(CHATGPT_URL)
      : sameChatGptConversationUrl(url, conversationUrl);
  const canDiscover =
    browser.tabs.selected !== undefined ||
    browser.tabs.list !== undefined ||
    browser.user?.openTabs !== undefined;
  const discoveryPasses = canDiscover ? 2 : 1;
  let discoveryError: unknown;

  for (let pass = 0; pass < discoveryPasses; pass += 1) {
    try {
      const selected = await browser.tabs.selected?.();
      if (selected && matchesTarget((await selected.url()) ?? "")) {
        await waitUntilLoaded(selected);
        return selected;
      }
    } catch (error) {
      if (!isTabUnavailableError(error)) throw error;
      discoveryError = error;
    }

    const sessionTabs = (await browser.tabs.list?.()) ?? [];
    const sessionCandidate = sessionTabs.find((candidate) =>
      matchesTarget(String(candidate.url ?? "")),
    );
    if (sessionCandidate?.id && browser.tabs.get) {
      const tab = await browser.tabs.get(sessionCandidate.id);
      await waitUntilLoaded(tab);
      return tab;
    }

    const openTabs = (await browser.user?.openTabs?.()) ?? [];
    const userCandidate = openTabs.find((candidate) =>
      matchesTarget(String(candidate.url ?? "")),
    );
    if (userCandidate && browser.user?.claimTab) {
      const tab = await browser.user.claimTab(userCandidate);
      await waitUntilLoaded(tab);
      return tab;
    }

    if (pass < discoveryPasses - 1) {
      await new Promise((resolve) => setTimeout(resolve, TAB_DISCOVERY_RETRY_MS));
    }
  }

  if (discoveryError !== undefined) throw discoveryError;
  const tab = await browser.tabs.new();
  await tab.goto(conversationUrl ?? CHATGPT_URL);
  await waitUntilLoaded(tab);
  return tab;
}

async function waitUntilLoaded(tab: IabTab): Promise<void> {
  await tab.playwright.waitForLoadState?.({
    state: "domcontentloaded",
    timeoutMs: 30_000,
  });
}
