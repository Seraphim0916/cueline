import {
  isExactChatGptConversationUrl as isConversationUrl,
  normalizedConversationUrl,
  sameChatGptConversationUrl,
} from "../../core/conversation-url.js";
import { CueLineError } from "../../core/errors.js";
import {
  readPageProbeState,
  resolveIabBrowser,
  type IabBrowser,
  type IabOpenTab,
  type IabTab,
  type PageProbeState,
} from "./bootstrap.js";
import {
  isProLabel,
  isProModelSlug,
} from "./recovery-evidence.js";
import { CHATGPT_URL } from "./selectors.js";

export interface CodexIabProbeOptions {
  browser?: IabBrowser;
  /** Restrict the probe to this exact ChatGPT conversation URL. */
  conversationUrl?: string;
}

export type CodexIabProbeStatus =
  | "ready"
  | "browser_missing"
  | "target_invalid"
  | "tab_not_found"
  | "tab_ambiguous"
  | "attach_failed";

export type CodexIabBrowserSource = "injected" | "global_browser" | "legacy_iab" | "agent";
export type CodexIabTabSource = "selected" | "session" | "user";

export interface CodexIabPageProbe {
  url: string;
  isConversation: boolean;
  isAnswering: boolean;
  assistantMessageCount: number;
  lastMessageRole: "assistant" | "user" | null;
  assistantModelSlug: string | null;
  selectedModelLabel: string | null;
  modelEvidence:
    | "pro"
    | "pro_response_only"
    | "non_pro"
    | "conflict"
    | "missing"
    | "ambiguous";
  composerState: PageProbeState["composerState"];
  inlineTextLength: number;
  attachmentCount: number;
  sendButtonState: PageProbeState["sendButtonState"];
}

export interface CodexIabProbeResult {
  status: CodexIabProbeStatus;
  errorCode: string | null;
  browserSource: CodexIabBrowserSource | null;
  tabSource: CodexIabTabSource | null;
  targetConversationUrl: string | null;
  page: CodexIabPageProbe | null;
}

interface ExistingTabResult {
  status: "ready" | "not_found" | "ambiguous" | "attach_failed";
  tab?: IabTab;
  source?: CodexIabTabSource;
}

function isChatGptUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === new URL(CHATGPT_URL).hostname &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.port === ""
    );
  } catch {
    return false;
  }
}

function matchesTarget(url: string, target: string | undefined): boolean {
  if (target === undefined) return isChatGptUrl(url);
  return sameChatGptConversationUrl(url, target);
}

function uniqueCandidates(
  candidates: IabOpenTab[],
  target: string | undefined,
): IabOpenTab[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const url = String(candidate.url ?? "");
    if (!matchesTarget(url, target)) return false;
    const normalized = normalizedConversationUrl(url);
    const key = isConversationUrl(normalized) ? normalized : candidate.id ?? normalized;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function existingTab(
  browser: IabBrowser,
  target: string | undefined,
): Promise<ExistingTabResult> {
  let attachFailed = false;
  try {
    const selected = await browser.tabs.selected?.();
    if (selected && matchesTarget((await selected.url()) ?? "", target)) {
      return { status: "ready", tab: selected, source: "selected" };
    }
  } catch {
    attachFailed = true;
  }

  let sessionCandidates: IabOpenTab[] = [];
  try {
    sessionCandidates = uniqueCandidates((await browser.tabs.list?.()) ?? [], target);
  } catch {
    attachFailed = true;
  }
  let userCandidates: IabOpenTab[] = [];
  try {
    userCandidates = uniqueCandidates((await browser.user?.openTabs?.()) ?? [], target);
  } catch {
    attachFailed = true;
  }
  const bySurfaceKey = new Map<
    string,
    { session?: IabOpenTab; user?: IabOpenTab }
  >();
  const addCandidate = (candidate: IabOpenTab, surface: "session" | "user"): void => {
    const url = normalizedConversationUrl(String(candidate.url ?? ""));
    const key = isConversationUrl(url) ? url : candidate.id ?? url;
    const existing = bySurfaceKey.get(key) ?? {};
    existing[surface] = candidate;
    bySurfaceKey.set(key, existing);
  };
  for (const candidate of sessionCandidates) addCandidate(candidate, "session");
  for (const candidate of userCandidates) addCandidate(candidate, "user");
  if (bySurfaceKey.size > 1) return { status: "ambiguous" };

  const only = bySurfaceKey.values().next().value as
    | { session?: IabOpenTab; user?: IabOpenTab }
    | undefined;
  if (only?.session !== undefined) {
    const candidate = only.session;
    if (candidate.id === undefined || browser.tabs.get === undefined) {
      return { status: "attach_failed" };
    }
    try {
      const tab = await browser.tabs.get(candidate.id);
      if (!matchesTarget((await tab.url()) ?? "", target)) return { status: "attach_failed" };
      return { status: "ready", tab, source: "session" };
    } catch {
      return { status: "attach_failed" };
    }
  }
  if (only?.user !== undefined) {
    if (browser.user?.claimTab === undefined) return { status: "attach_failed" };
    try {
      const tab = await browser.user.claimTab(only.user);
      if (!matchesTarget((await tab.url()) ?? "", target)) return { status: "attach_failed" };
      return { status: "ready", tab, source: "user" };
    } catch {
      return { status: "attach_failed" };
    }
  }
  return { status: attachFailed ? "attach_failed" : "not_found" };
}

function browserSource(options: CodexIabProbeOptions): CodexIabBrowserSource | null {
  if (options.browser !== undefined) return "injected";
  if (globalThis.browser !== undefined) return "global_browser";
  if (globalThis.iab !== undefined) return "legacy_iab";
  if (globalThis.agent?.browsers?.get !== undefined) return "agent";
  return null;
}

function unavailable(
  status: Exclude<CodexIabProbeStatus, "ready">,
  errorCode: string,
  source: CodexIabBrowserSource | null,
  target: string | null,
): CodexIabProbeResult {
  return {
    status,
    errorCode,
    browserSource: source,
    tabSource: null,
    targetConversationUrl: target,
    page: null,
  };
}

function safeModelSlug(value: string | null): string | null {
  return value !== null &&
    /^(?:gpt-[a-z0-9][a-z0-9._-]{0,71}|chatgpt-[a-z0-9][a-z0-9._-]{0,67}|o[1-9][0-9]?(?:-[a-z0-9][a-z0-9._-]{0,72})?)$/i.test(value)
    ? value
    : null;
}

function modelEvidence(
  state: PageProbeState,
  assistantModelSlug: string | null,
): CodexIabPageProbe["modelEvidence"] {
  if (state.modelLabelCount > 1) return "ambiguous";
  if (state.selectedModelLabel === null && assistantModelSlug === null) return "missing";
  const composerIsPro = isProLabel(state.selectedModelLabel);
  const responseIsPro = isProModelSlug(assistantModelSlug);
  if (state.selectedModelLabel === null) {
    return responseIsPro ? "pro_response_only" : "non_pro";
  }
  if (assistantModelSlug === null) return composerIsPro ? "pro" : "non_pro";
  if (composerIsPro !== responseIsPro) return "conflict";
  return composerIsPro ? "pro" : "non_pro";
}

/**
 * Inspect an existing ChatGPT tab without creating, navigating, filling, or
 * clicking. The result is deliberately redacted and safe for diagnostics.
 */
export async function probeCodexIab(
  options: CodexIabProbeOptions = {},
): Promise<CodexIabProbeResult> {
  const source = browserSource(options);
  if (
    options.conversationUrl !== undefined &&
    !isConversationUrl(options.conversationUrl)
  ) {
    return unavailable(
      "target_invalid",
      "IAB_CONVERSATION_URL_INVALID",
      source,
      null,
    );
  }
  const target =
    options.conversationUrl === undefined
      ? null
      : normalizedConversationUrl(options.conversationUrl);

  let browser: IabBrowser;
  try {
    browser = await resolveIabBrowser(options.browser);
  } catch (error) {
    if (error instanceof CueLineError && error.code === "IAB_BROWSER_MISSING") {
      return unavailable("browser_missing", error.code, null, target);
    }
    return unavailable("attach_failed", "IAB_BROWSER_ATTACH_FAILED", source, target);
  }

  const located = await existingTab(browser, target ?? undefined);
  if (located.status === "not_found") {
    return unavailable("tab_not_found", "IAB_CHATGPT_TAB_NOT_FOUND", source, target);
  }
  if (located.status === "ambiguous") {
    return unavailable("tab_ambiguous", "IAB_CHATGPT_TAB_AMBIGUOUS", source, target);
  }
  if (located.status === "attach_failed" || located.tab === undefined || located.source === undefined) {
    return unavailable("attach_failed", "IAB_ATTACH_FAILED", source, target);
  }

  try {
    const state = await readPageProbeState(located.tab);
    const observedUrl = normalizedConversationUrl(state.pageUrl);
    if (!matchesTarget(observedUrl, target ?? undefined)) {
      return unavailable("attach_failed", "IAB_PROBE_TARGET_CHANGED", source, target);
    }
    const assistantModelSlug = safeModelSlug(state.assistantModelSlug);
    return {
      status: "ready",
      errorCode: null,
      browserSource: source,
      tabSource: located.source,
      targetConversationUrl: target,
      page: {
        url: observedUrl,
        isConversation: isConversationUrl(observedUrl),
        isAnswering: state.isAnswering,
        assistantMessageCount: state.assistantMessageCount,
        lastMessageRole: state.lastMessageRole,
        assistantModelSlug,
        selectedModelLabel: state.selectedModelLabel,
        modelEvidence: modelEvidence(state, assistantModelSlug),
        composerState: state.composerState,
        inlineTextLength: state.inlineTextLength,
        attachmentCount: state.attachmentCount,
        sendButtonState: state.sendButtonState,
      },
    };
  } catch {
    return unavailable("attach_failed", "IAB_PAGE_PROBE_FAILED", source, target);
  }
}
