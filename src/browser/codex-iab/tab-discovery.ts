import { CueLineError } from "../../core/errors.js";
import { sameChatGptConversationUrl } from "../../core/conversation-url.js";
import type { IabBrowser, IabOpenTab, IabTab } from "./bootstrap.js";
import { CHATGPT_URL } from "./selectors.js";

const TAB_DISCOVERY_RETRY_MS = 100;

function uniqueTabListings(candidates: readonly IabOpenTab[]): IabOpenTab[] {
  const seenIds = new Set<string>();
  return candidates.filter((candidate) => {
    if (candidate.id === undefined) return true;
    if (seenIds.has(candidate.id)) return false;
    seenIds.add(candidate.id);
    return true;
  });
}

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
  let ambiguousCandidates: { source: "session" | "user"; count: number } | undefined;

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

    const getSessionTab = browser.tabs.get;
    const sessionCandidates = uniqueTabListings(
      ((await browser.tabs.list?.()) ?? []).filter(
        (candidate) =>
          candidate.id !== undefined &&
          getSessionTab !== undefined &&
          matchesTarget(String(candidate.url ?? "")),
      ),
    );
    if (sessionCandidates.length === 1) {
      const tab = await getSessionTab!(sessionCandidates[0]!.id!);
      await waitUntilLoaded(tab);
      return tab;
    }
    if (sessionCandidates.length > 1) {
      ambiguousCandidates = { source: "session", count: sessionCandidates.length };
    }

    if (sessionCandidates.length === 0) {
      const claimUserTab = browser.user?.claimTab;
      const userCandidates = uniqueTabListings(
        ((await browser.user?.openTabs?.()) ?? []).filter(
          (candidate) =>
            claimUserTab !== undefined &&
            matchesTarget(String(candidate.url ?? "")),
        ),
      );
      if (userCandidates.length === 1) {
        const tab = await claimUserTab!(userCandidates[0]!);
        await waitUntilLoaded(tab);
        return tab;
      }
      if (userCandidates.length > 1) {
        ambiguousCandidates = { source: "user", count: userCandidates.length };
      }
    }

    if (pass < discoveryPasses - 1) {
      await new Promise((resolve) => setTimeout(resolve, TAB_DISCOVERY_RETRY_MS));
    }
  }

  if (ambiguousCandidates !== undefined) {
    throw new CueLineError(
      "IAB_CHATGPT_TAB_AMBIGUOUS",
      "Multiple matching ChatGPT tabs are available and no selected tab disambiguates them. Select the intended tab and retry; CueLine will not guess or send.",
      {
        details: {
          source: ambiguousCandidates.source,
          matching_tabs: ambiguousCandidates.count,
          exact_conversation_requested: conversationUrl !== undefined,
        },
      },
    );
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
