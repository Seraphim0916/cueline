import assert from "node:assert/strict";
import test from "node:test";

import { probeCodexIab } from "../../src/browser/codex-iab/probe.js";
import {
  readPageProbeState,
  type IabBrowser,
  type IabTab,
  type PageProbeState,
} from "../../src/browser/codex-iab/bootstrap.js";

function probeTab(
  url: string,
  state: PageProbeState = {
    pageUrl: url,
    isAnswering: false,
    assistantMessageCount: 2,
    lastMessageRole: "assistant" as const,
    assistantModelSlug: "gpt-5-6-pro",
    selectedModelLabel: "Pro",
    modelLabelCount: 1,
    composerState: "attachment_ready" as const,
    inlineTextLength: 0,
    attachmentCount: 1,
    sendButtonState: "enabled" as const,
  },
): { tab: IabTab; counters: Record<string, number> } {
  const counters = { evaluate: 0, goto: 0, click: 0, fill: 0 };
  const tab: IabTab = {
    async goto() {
      counters.goto += 1;
    },
    async url() {
      return url;
    },
    playwright: {
      getByRole() {
        return {
          async count() { return 0; },
          async fill() { counters.fill += 1; },
          async click() { counters.click += 1; },
        };
      },
      async evaluate<Result, Argument>(
        _pageFunction: (argument: Argument) => Result | Promise<Result>,
        argument?: Argument,
      ): Promise<Result> {
        counters.evaluate += 1;
        assert.deepEqual(argument, { diagnosticProbe: true });
        return state as Result;
      },
      async domSnapshot() {
        return {};
      },
      async waitForTimeout() {},
      async waitForLoadState() {},
    },
  };
  return { tab, counters };
}

test("public browser probe returns a redacted state without browser mutations", async () => {
  const rawPrompt = "PROMPT_SENTINEL_DO_NOT_LEAK";
  const rawAssistant = "ASSISTANT_SENTINEL_DO_NOT_LEAK";
  const attachmentName = "private-farm-plan.txt";
  const fixture = probeTab("https://chatgpt.com/c/probe-ready");
  let newTabs = 0;
  const browser: IabBrowser = {
    tabs: {
      async selected() { return fixture.tab; },
      async new() {
        newTabs += 1;
        return fixture.tab;
      },
    },
  };

  const result = await probeCodexIab({ browser });

  assert.deepEqual(result, {
    status: "ready",
    errorCode: null,
    browserSource: "injected",
    tabSource: "selected",
    targetConversationUrl: null,
    page: {
      url: "https://chatgpt.com/c/probe-ready",
      isConversation: true,
      isAnswering: false,
      assistantMessageCount: 2,
      lastMessageRole: "assistant",
      assistantModelSlug: "gpt-5-6-pro",
      selectedModelLabel: "Pro",
      modelEvidence: "pro",
      composerState: "attachment_ready",
      inlineTextLength: 0,
      attachmentCount: 1,
      sendButtonState: "enabled",
    },
  });
  assert.equal(newTabs, 0);
  assert.deepEqual(fixture.counters, { evaluate: 1, goto: 0, click: 0, fill: 0 });
  const serialized = JSON.stringify(result);
  for (const secret of [rawPrompt, rawAssistant, attachmentName]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("browser probe refuses to guess between multiple ChatGPT tabs", async () => {
  let gets = 0;
  let claims = 0;
  let newTabs = 0;
  const browser: IabBrowser = {
    tabs: {
      async selected() { return undefined; },
      async list() {
        return [
          { id: "one", url: "https://chatgpt.com/c/one" },
          { id: "two", url: "https://chatgpt.com/c/two" },
        ];
      },
      async get() {
        gets += 1;
        return probeTab("https://chatgpt.com/c/one").tab;
      },
      async new() {
        newTabs += 1;
        return probeTab("https://chatgpt.com/").tab;
      },
    },
    user: {
      async openTabs() { return []; },
      async claimTab() {
        claims += 1;
        return probeTab("https://chatgpt.com/c/one").tab;
      },
    },
  };

  const result = await probeCodexIab({ browser });

  assert.equal(result.status, "tab_ambiguous");
  assert.equal(result.errorCode, "IAB_CHATGPT_TAB_AMBIGUOUS");
  assert.equal(result.page, null);
  assert.equal(gets, 0);
  assert.equal(claims, 0);
  assert.equal(newTabs, 0);
});

test("browser probe detects ambiguity across session and user tab inventories", async () => {
  let gets = 0;
  let claims = 0;
  const browser: IabBrowser = {
    tabs: {
      async selected() { return undefined; },
      async list() {
        return [{ id: "session-one", url: "https://chatgpt.com/c/session-one" }];
      },
      async get() {
        gets += 1;
        return probeTab("https://chatgpt.com/c/session-one").tab;
      },
      async new() {
        throw new Error("probe must not create a tab");
      },
    },
    user: {
      async openTabs() {
        return [{ id: "user-two", url: "https://chatgpt.com/c/user-two" }];
      },
      async claimTab() {
        claims += 1;
        return probeTab("https://chatgpt.com/c/user-two").tab;
      },
    },
  };

  const result = await probeCodexIab({ browser });

  assert.equal(result.status, "tab_ambiguous");
  assert.equal(gets, 0);
  assert.equal(claims, 0);
});

test("an exact target conversation disambiguates existing session tabs", async () => {
  const target = probeTab("https://chatgpt.com/c/two?temporary-chat=true");
  let selectedId: string | undefined;
  const browser: IabBrowser = {
    tabs: {
      async selected() { return undefined; },
      async list() {
        return [
          { id: "one", url: "https://chatgpt.com/c/one" },
          { id: "two", url: "https://chatgpt.com/c/two?temporary-chat=true" },
        ];
      },
      async get(id) {
        selectedId = id;
        return target.tab;
      },
      async new() {
        throw new Error("probe must not create a tab");
      },
    },
  };

  const result = await probeCodexIab({
    browser,
    conversationUrl: "https://chatgpt.com/c/two",
  });

  assert.equal(result.status, "ready");
  assert.equal(result.tabSource, "session");
  assert.equal(result.targetConversationUrl, "https://chatgpt.com/c/two");
  assert.equal(selectedId, "two");
  assert.equal(target.counters.goto, 0);
});

test("duplicate inventory entries for the same conversation prefer the attached session tab", async () => {
  const target = probeTab("https://chatgpt.com/c/same-conversation");
  let claims = 0;
  const browser: IabBrowser = {
    tabs: {
      async selected() { return undefined; },
      async list() {
        return [{ id: "session", url: "https://chatgpt.com/c/same-conversation" }];
      },
      async get() { return target.tab; },
      async new() { throw new Error("probe must not create a tab"); },
    },
    user: {
      async openTabs() {
        return [{ id: "user", url: "https://chatgpt.com/c/same-conversation?model=pro" }];
      },
      async claimTab() {
        claims += 1;
        return target.tab;
      },
    },
  };

  const result = await probeCodexIab({ browser });

  assert.equal(result.status, "ready");
  assert.equal(result.tabSource, "session");
  assert.equal(claims, 0);
});

test("invalid target URLs are rejected before touching the Browser runtime", async () => {
  const sentinel = "PRIVATE_TARGET_SENTINEL";
  let documentationCalls = 0;
  const browser: IabBrowser = {
    async documentation() { documentationCalls += 1; },
    tabs: {
      async new() { throw new Error("probe must not create a tab"); },
    },
  };

  const result = await probeCodexIab({
    browser,
    conversationUrl: `not-a-url?token=${sentinel}`,
  });

  assert.equal(result.status, "target_invalid");
  assert.equal(result.errorCode, "IAB_CONVERSATION_URL_INVALID");
  assert.equal(result.targetConversationUrl, null);
  assert.equal(JSON.stringify(result).includes(sentinel), false);
  assert.equal(documentationCalls, 0);
});

test("probe rejects a tab that navigates away between discovery and DOM evaluation", async () => {
  const sentinel = "NAVIGATION_RACE_SENTINEL";
  const fixture = probeTab("https://chatgpt.com/c/expected", {
    pageUrl: `https://example.com/${sentinel}`,
    isAnswering: false,
    assistantMessageCount: 0,
    lastMessageRole: null,
    assistantModelSlug: null,
    selectedModelLabel: "Pro",
    modelLabelCount: 1,
    composerState: "empty",
    inlineTextLength: 0,
    attachmentCount: 0,
    sendButtonState: "missing",
  });
  const browser: IabBrowser = {
    tabs: {
      async selected() { return fixture.tab; },
      async new() { throw new Error("probe must not create a tab"); },
    },
  };

  const result = await probeCodexIab({
    browser,
    conversationUrl: "https://chatgpt.com/c/expected",
  });

  assert.equal(result.status, "attach_failed");
  assert.equal(result.errorCode, "IAB_PROBE_TARGET_CHANGED");
  assert.equal(result.page, null);
  assert.equal(JSON.stringify(result).includes(sentinel), false);
});

test("probe filters untrusted response-model attributes from diagnostics", async () => {
  const sentinel = "private-model-attribute-sentinel-123456789";
  const fixture = probeTab("https://chatgpt.com/c/model-sanitized", {
    pageUrl: "https://chatgpt.com/c/model-sanitized",
    isAnswering: false,
    assistantMessageCount: 1,
    lastMessageRole: "assistant",
    assistantModelSlug: sentinel,
    selectedModelLabel: "Pro",
    modelLabelCount: 1,
    composerState: "empty",
    inlineTextLength: 0,
    attachmentCount: 0,
    sendButtonState: "missing",
  });
  const browser: IabBrowser = {
    tabs: {
      async selected() { return fixture.tab; },
      async new() { throw new Error("probe must not create a tab"); },
    },
  };

  const result = await probeCodexIab({ browser });

  assert.equal(result.status, "ready");
  assert.equal(result.page?.assistantModelSlug, null);
  assert.equal(JSON.stringify(result).includes(sentinel), false);
});

test("response-only Pro evidence is partial, not falsely classified as non-Pro", async () => {
  const fixture = probeTab("https://chatgpt.com/c/archived-pro", {
    pageUrl: "https://chatgpt.com/c/archived-pro",
    isAnswering: false,
    assistantMessageCount: 1,
    lastMessageRole: "assistant",
    assistantModelSlug: "gpt-5-6-pro",
    selectedModelLabel: null,
    modelLabelCount: 0,
    composerState: "missing",
    inlineTextLength: 0,
    attachmentCount: 0,
    sendButtonState: "missing",
  });
  const browser: IabBrowser = {
    tabs: {
      async selected() { return fixture.tab; },
      async new() { throw new Error("probe must not create a tab"); },
    },
  };

  const result = await probeCodexIab({ browser });

  assert.equal(result.status, "ready");
  assert.equal(result.page?.modelEvidence, "pro_response_only");
});

test("conflicting composer and response model evidence is explicit", async () => {
  const fixture = probeTab("https://chatgpt.com/c/model-conflict", {
    pageUrl: "https://chatgpt.com/c/model-conflict",
    isAnswering: false,
    assistantMessageCount: 1,
    lastMessageRole: "assistant",
    assistantModelSlug: "gpt-5-6-instant",
    selectedModelLabel: "Pro",
    modelLabelCount: 1,
    composerState: "empty",
    inlineTextLength: 0,
    attachmentCount: 0,
    sendButtonState: "missing",
  });
  const browser: IabBrowser = {
    tabs: {
      async selected() { return fixture.tab; },
      async new() { throw new Error("probe must not create a tab"); },
    },
  };

  const result = await probeCodexIab({ browser });

  assert.equal(result.status, "ready");
  assert.equal(result.page?.modelEvidence, "conflict");
});

test("page-evaluation failures return a stable code without leaking raw errors", async () => {
  const sentinel = "COOKIE_OR_SESSION_SENTINEL";
  const tab = probeTab("https://chatgpt.com/c/failing-probe").tab;
  tab.playwright.evaluate = async () => {
    throw new Error(sentinel);
  };
  const browser: IabBrowser = {
    tabs: {
      async selected() { return tab; },
      async new() { throw new Error("probe must not create a tab"); },
    },
  };

  const result = await probeCodexIab({ browser });

  assert.equal(result.status, "attach_failed");
  assert.equal(result.errorCode, "IAB_PAGE_PROBE_FAILED");
  assert.equal(JSON.stringify(result).includes(sentinel), false);
});

test("browser probe reports a missing runtime as structured diagnostics", async () => {
  const globals = globalThis as typeof globalThis & {
    browser?: IabBrowser;
    iab?: IabBrowser;
    agent?: unknown;
  };
  const descriptors = new Map(
    ["browser", "iab", "agent"].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ] as const),
  );
  delete globals.browser;
  delete globals.iab;
  delete globals.agent;

  try {
    const result = await probeCodexIab();
    assert.equal(result.status, "browser_missing");
    assert.equal(result.errorCode, "IAB_BROWSER_MISSING");
    assert.equal(result.page, null);
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
});

test("page probe recognizes an attachment and ignores a hidden residual Stop button", async () => {
  let includeLocalizedStop = false;
  let localizedStopAria = "停止產生";
  let localizedStopText = "停止產生";
  const hiddenStop = {
    disabled: false,
    hidden: false,
    textContent: "Stop answering",
    getAttribute(name: string) {
      if (name === "aria-label") return "Stop answering";
      if (name === "aria-hidden") return "true";
      return null;
    },
    closest(selector: string) { return selector.includes("aria-hidden") ? this : null; },
    getBoundingClientRect() { return { width: 0, height: 0 }; },
    getClientRects() { return []; },
  };
  const send = {
    disabled: false,
    hidden: false,
    innerText: "Send prompt",
    textContent: "Send prompt",
    getAttribute(name: string) {
      if (name === "aria-label") return "Send prompt";
      return null;
    },
    closest() { return null; },
    getBoundingClientRect() { return { width: 40, height: 40 }; },
    getClientRects() { return [{}]; },
  };
  const localizedStop = {
    disabled: false,
    hidden: false,
    get textContent() {
      return localizedStopText;
    },
    getAttribute(name: string) {
      if (name === "aria-label") return localizedStopAria;
      return null;
    },
    closest() { return null; },
    getBoundingClientRect() { return { width: 40, height: 40 }; },
    getClientRects() { return [{}]; },
  };
  const attachment = {
    getAttribute(name: string) {
      if (name === "data-testid") return "file-upload-preview";
      if (name === "aria-label") return "Remove private-farm-plan.txt";
      return null;
    },
  };
  const model = {
    hidden: false,
    innerText: "Pro",
    textContent: "Pro",
    getAttribute(name: string) { return name === "aria-label" ? "Pro" : null; },
    closest() { return null; },
    getBoundingClientRect() { return { width: 80, height: 32 }; },
    getClientRects() { return [{}]; },
  };
  const assistant = {
    getAttribute(name: string) {
      if (name === "data-message-author-role") return "assistant";
      if (name === "data-message-model-slug") return "gpt-5-6-pro";
      return null;
    },
  };
  const form = {
    querySelectorAll(selector: string) {
      if (selector === "button") return [send];
      if (selector.includes("file-upload-preview")) return [attachment];
      return [];
    },
  };
  const composer = {
    innerText: "",
    textContent: "",
    closest(selector: string) { return selector === "form" ? form : null; },
    parentElement: null,
  };
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const styleDescriptor = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      querySelector(selector: string) {
        return selector.includes("prompt-textarea") ? composer : null;
      },
      querySelectorAll(selector: string) {
        if (selector === "button") {
          return includeLocalizedStop ? [hiddenStop, localizedStop, send] : [hiddenStop, send];
        }
        if (selector === "button.__composer-pill") return [model];
        if (selector === "[data-message-author-role]") return [assistant];
        return [];
      },
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { href: "https://chatgpt.com/c/probe-dom" } },
  });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: (element: unknown) =>
      element === hiddenStop
        ? { display: "none", visibility: "hidden", opacity: "0", pointerEvents: "none" }
        : { display: "block", visibility: "visible", opacity: "1", pointerEvents: "auto" },
  });
  const tab = {
    playwright: {
      async evaluate<Result, Argument>(
        pageFunction: (argument: Argument) => Result | Promise<Result>,
        argument?: Argument,
      ): Promise<Result> {
        return pageFunction(argument as Argument);
      },
    },
  } as unknown as IabTab;

  try {
    const state = await readPageProbeState(tab);
    assert.deepEqual(state, {
      pageUrl: "https://chatgpt.com/c/probe-dom",
      isAnswering: false,
      assistantMessageCount: 1,
      lastMessageRole: "assistant",
      assistantModelSlug: "gpt-5-6-pro",
      selectedModelLabel: "Pro",
      modelLabelCount: 1,
      composerState: "attachment_ready",
      inlineTextLength: 0,
      attachmentCount: 1,
      sendButtonState: "enabled",
    });
    assert.equal("assistantText" in state, false);
    assert.equal("lastUserText" in state, false);
    assert.equal(JSON.stringify(state).includes("private-farm-plan.txt"), false);
    includeLocalizedStop = true;
    assert.equal((await readPageProbeState(tab)).isAnswering, true);
    localizedStopAria = "Stop sharing";
    localizedStopText = "Generating preview";
    assert.equal(
      (await readPageProbeState(tab)).isAnswering,
      false,
      "does not combine unrelated aria and visible-text tokens",
    );
    localizedStopAria = "";
    localizedStopText = "応答を停止";
    assert.equal((await readPageProbeState(tab)).isAnswering, true, "visible-text fallback");
  } finally {
    for (const [name, descriptor] of [
      ["document", documentDescriptor],
      ["window", windowDescriptor],
      ["getComputedStyle", styleDescriptor],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
});
