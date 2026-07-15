import assert from "node:assert/strict";
import test from "node:test";

import { createCodexIabAdapter } from "../../src/browser/codex-iab/chatgpt-client.js";
import { CueLineError } from "../../src/core/errors.js";
import {
  readPageChatState,
  readPageComposerState,
  resolveIabBrowser,
  type IabBrowser,
  type IabLocator,
  type IabTab,
  type PageComposerState,
  type PageChatState,
} from "../../src/browser/codex-iab/bootstrap.js";
/*
 * Keep these browser-runtime tests at the public adapter boundary. The actual
 * page evaluator runs against a tiny DOM double so newline handling cannot be
 * accidentally hidden by fake precomputed composer states.
 */
type BrowserGlobals = typeof globalThis & {
  browser?: IabBrowser;
  iab?: IabBrowser;
};

class FakeLocator implements IabLocator {
  readonly fills: string[] = [];
  readonly waits: Array<{ state: string; timeoutMs?: number }> = [];
  clicks = 0;
  countResult = 1;
  failFirstClick = false;
  invokeOnClickBeforeFailure = false;
  firstClickError = "Playwright timeout: detached button";

  constructor(readonly onClick?: () => void) {}

  async count(): Promise<number> {
    return this.countResult;
  }

  async fill(value: string): Promise<void> {
    this.fills.push(value);
  }

  async waitFor(options: { state: string; timeoutMs?: number }): Promise<void> {
    this.waits.push(options);
  }

  async click(): Promise<void> {
    this.clicks += 1;
    if (this.failFirstClick && this.clicks === 1) {
      if (this.invokeOnClickBeforeFailure) this.onClick?.();
      throw new Error(this.firstClickError);
    }
    this.onClick?.();
  }
}

function fakeBrowser(options: {
  states: Array<
    Omit<
      PageChatState,
      "pageUrl" | "assistantModelSlug" | "lastUserText" | "lastMessageRole"
    > & {
      pageUrl?: string;
      assistantModelSlug?: string | null;
      lastUserText?: string | null;
      lastMessageRole?: "assistant" | "user" | null;
    }
  >;
  initialUrl?: string;
  submittedUrl?: string;
  failFirstClick?: boolean;
  firstSendClickSubmitsBeforeThrow?: boolean;
  cuaAvailable?: boolean;
  coordinateClickError?: string;
  coordinateClickSubmitsBeforeThrow?: boolean;
  firstClickError?: string;
  failStateReadAt?: number;
  stateReadError?: string;
  hydratedComposer?: boolean;
  sendButtonAvailable?: boolean;
  initialModel?: string | null;
  legacyModelPickerPresent?: boolean;
  modelReadSequence?: Array<string | null>;
  proOptionAvailable?: boolean;
  proSelectionSucceeds?: boolean;
  responseModelSlug?: string | null;
  composerStates?: PageComposerState[];
  urlReadSequence?: string[];
}) {
  const composer = new FakeLocator();
  const hydratedComposer = new FakeLocator();
  const missingHydratedComposer = new FakeLocator();
  missingHydratedComposer.countResult = 0;
  let sendSubmissions = 0;
  const sendButtons = [
    new FakeLocator(() => { sendSubmissions += 1; }),
    new FakeLocator(() => { sendSubmissions += 1; }),
  ];
  const missingSendButton = new FakeLocator();
  missingSendButton.countResult = 0;
  let modelLabel = options.initialModel === undefined ? "Pro" : options.initialModel;
  let modelRead = 0;
  const modelPicker = new FakeLocator();
  const proOption = new FakeLocator(() => {
    if (options.proSelectionSucceeds !== false) modelLabel = "Pro";
  });
  const missingProOption = new FakeLocator();
  missingProOption.countResult = 0;
  sendButtons[0]!.failFirstClick = options.failFirstClick ?? false;
  sendButtons[0]!.invokeOnClickBeforeFailure =
    options.firstSendClickSubmitsBeforeThrow ?? false;
  sendButtons[0]!.firstClickError = options.firstClickError ?? sendButtons[0]!.firstClickError;
  for (const sendButton of sendButtons) {
    sendButton.firstClickError = options.firstClickError ?? sendButton.firstClickError;
  }
  const requestedRoles: Array<{ role: string; name: string }> = [];
  const requestedSelectors: string[] = [];
  let stateIndex = 0;
  let stateRead = 0;
  let url = options.initialUrl ?? "https://chatgpt.com/";
  let sendLookup = 0;
  let coordinateClicks = 0;
  let composerStateRead = 0;
  let urlRead = 0;

  const playwright = {
    locator(selector: string) {
      requestedSelectors.push(selector);
      if (selector === "button.__composer-pill") return modelPicker;
      return options.hydratedComposer ? hydratedComposer : missingHydratedComposer;
    },
    getByRole(role: string, query: { name: string }) {
      requestedRoles.push({ role, name: query.name });
      if (role === "textbox") return composer;
      if (role === "menuitemradio" && query.name === "Pro") {
        return options.proOptionAvailable === false ? missingProOption : proOption;
      }
      if (options.sendButtonAvailable === false) {
        return missingSendButton;
      }
      const locator = sendButtons[Math.min(sendLookup, sendButtons.length - 1)]!;
      sendLookup += 1;
      return locator;
    },
    async evaluate<Result, Argument = undefined>(
      _pageFunction: (argument: Argument) => Result | Promise<Result>,
      argument?: Argument,
    ) {
      if (
        typeof argument === "object" &&
        argument !== null &&
        "composerProbe" in argument
      ) {
        const states = options.composerStates ?? [
          {
            state: "inline_ready",
            inlineTextLength:
              typeof (argument as { expectedPrompt?: unknown }).expectedPrompt === "string"
                ? (argument as unknown as { expectedPrompt: string }).expectedPrompt.length
                : 1,
            attachmentCount: 0,
            sendButtonEnabled: true,
          },
        ];
        const state = states[Math.min(composerStateRead, states.length - 1)]!;
        composerStateRead += 1;
        return state as Result;
      }
      if (
        typeof argument === "object" &&
        argument !== null &&
        "modelPickerSelector" in argument
      ) {
        if (options.modelReadSequence) {
          const value =
            options.modelReadSequence[
              Math.min(modelRead, options.modelReadSequence.length - 1)
            ] ?? null;
          modelRead += 1;
          return value as Result;
        }
        const hasLegacyPicker = options.legacyModelPickerPresent !== false;
        return (hasLegacyPicker ? modelLabel : null) as Result;
      }
      if (
        typeof argument === "object" &&
        argument !== null &&
        "sendButtonNames" in argument
      ) {
        return { x: 1024, y: 398 } as Result;
      }
      const currentRead = stateRead;
      stateRead += 1;
      if (options.failStateReadAt === currentRead) {
        throw new Error(options.stateReadError ?? "Browser webview attach timeout");
      }
      const state = options.states[Math.min(stateIndex, options.states.length - 1)]!;
      stateIndex += 1;
      if (!state.isAnswering && options.submittedUrl) {
        url = options.submittedUrl;
      }
      return {
        ...state,
        pageUrl: state.pageUrl ?? url,
        lastUserText: state.lastUserText ?? null,
        lastMessageRole:
          state.lastMessageRole ?? (state.assistantMessageCount > 0 ? "assistant" : null),
        assistantModelSlug:
          state.assistantModelSlug ??
          (state.assistantMessageCount > 0
            ? options.responseModelSlug ?? "gpt-5-6-pro"
            : null),
      } as Result;
    },
    async domSnapshot() {
      return {};
    },
    async waitForTimeout() {},
  };

  const tab: IabTab = {
    async goto(nextUrl) {
      url = nextUrl;
    },
    async url() {
      if (options.urlReadSequence) {
        const next = options.urlReadSequence[
          Math.min(urlRead, options.urlReadSequence.length - 1)
        ];
        urlRead += 1;
        if (next !== undefined) return next;
      }
      return url;
    },
    playwright,
  };
  if (options.cuaAvailable) {
    tab.cua = {
      async click({ x, y }) {
        assert.deepEqual({ x, y }, { x: 1024, y: 398 });
        coordinateClicks += 1;
        if (options.coordinateClickSubmitsBeforeThrow) sendSubmissions += 1;
        if (options.coordinateClickError) throw new Error(options.coordinateClickError);
        sendSubmissions += 1;
      },
    };
  }
  const browser: IabBrowser = {
    async documentation() {},
    tabs: { async new() { return tab; } },
  };
  return {
    browser,
    tab,
    composer,
    hydratedComposer,
    modelPicker,
    proOption,
    requestedRoles,
    requestedSelectors,
    sendButtons,
    coordinateClicks: () => coordinateClicks,
    sendSubmissions: () => sendSubmissions,
  };
}

test("rejects unsafe browser timing options before touching the Browser runtime", () => {
  const invalid: Array<{
    options: Parameters<typeof createCodexIabAdapter>[0];
    code: string;
  }> = [
    { options: { timeoutMs: 0 }, code: "IAB_TIMEOUT_INVALID" },
    { options: { timeoutMs: -1 }, code: "IAB_TIMEOUT_INVALID" },
    { options: { timeoutMs: Number.NaN }, code: "IAB_TIMEOUT_INVALID" },
    { options: { timeoutMs: Number.POSITIVE_INFINITY }, code: "IAB_TIMEOUT_INVALID" },
    { options: { timeoutMs: 2_147_483_648 }, code: "IAB_TIMEOUT_INVALID" },
    { options: { pollIntervalMs: 0 }, code: "IAB_POLL_INTERVAL_INVALID" },
    { options: { pollIntervalMs: -1 }, code: "IAB_POLL_INTERVAL_INVALID" },
    { options: { pollIntervalMs: 0.5 }, code: "IAB_POLL_INTERVAL_INVALID" },
    { options: { pollIntervalMs: 2_147_483_648 }, code: "IAB_POLL_INTERVAL_INVALID" },
    { options: { stableMs: -1 }, code: "IAB_STABLE_WINDOW_INVALID" },
    { options: { stableMs: Number.NaN }, code: "IAB_STABLE_WINDOW_INVALID" },
    { options: { stableMs: 0.5 }, code: "IAB_STABLE_WINDOW_INVALID" },
    { options: { stableMs: 2_147_483_648 }, code: "IAB_STABLE_WINDOW_INVALID" },
  ];

  for (const fixture of invalid) {
    assert.throws(
      () => createCodexIabAdapter(fixture.options),
      (error: unknown) => error instanceof CueLineError && error.code === fixture.code,
    );
  }
});

test("accepts an explicit zero stabilization window for deterministic tests", () => {
  assert.doesNotThrow(() =>
    createCodexIabAdapter({ timeoutMs: 1, pollIntervalMs: 1, stableMs: 0 }),
  );
});

test("treats contenteditable block newlines as the same inline prompt", async () => {
  const sendButton = {
    disabled: false,
    innerText: "Send prompt",
    textContent: "Send prompt",
    getAttribute(name: string) {
      if (name === "aria-label") return "Send prompt";
      if (name === "aria-disabled") return "false";
      return null;
    },
  };
  const form = {
    querySelectorAll(selector: string) {
      return selector === "button" ? [sendButton] : [];
    },
  };
  const composer = {
    innerText: "first line\n\nsecond line",
    textContent: "first line\n\nsecond line",
    parentElement: null,
    closest() {
      return form;
    },
  };
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      querySelector() {
        return composer;
      },
    },
  });
  const tab = {
    playwright: {
      async evaluate<Result, Argument>(
        pageFunction: (argument: Argument) => Result | Promise<Result>,
        argument: Argument,
      ): Promise<Result> {
        return pageFunction(argument);
      },
    },
  } as unknown as IabTab;

  try {
    const state = await readPageComposerState(
      tab,
      "first line\nsecond line",
      ["Send prompt"],
    );
    assert.equal(state.state, "inline_ready");
    assert.equal(state.sendButtonEnabled, true);
  } finally {
    if (documentDescriptor) {
      Object.defineProperty(globalThis, "document", documentDescriptor);
    } else {
      delete (globalThis as { document?: unknown }).document;
    }
  }
});

test("ignores a hidden residual Stop answering button after the Pro response completed", async () => {
  const stopButton = {
    disabled: false,
    hidden: false,
    textContent: "Stop answering",
    getAttribute(name: string) {
      if (name === "aria-label") return "Stop answering";
      if (name === "aria-hidden") return "true";
      return null;
    },
    closest(selector: string) {
      return selector.includes("aria-hidden") ? this : null;
    },
    getBoundingClientRect() {
      return { width: 0, height: 0 };
    },
    getClientRects() {
      return [];
    },
  };
  const assistant = {
    innerText: "<CueLineControl>{\"action\":\"inspect\"}</CueLineControl>",
    textContent: "<CueLineControl>{\"action\":\"inspect\"}</CueLineControl>",
    getAttribute(name: string) {
      if (name === "data-message-author-role") return "assistant";
      if (name === "data-message-model-slug") return "gpt-5-6-pro";
      return null;
    },
  };
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const styleDescriptor = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      querySelectorAll(selector: string) {
        if (selector === "button") return [stopButton];
        if (selector === "[data-message-author-role]") return [assistant];
        return [];
      },
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { href: "https://chatgpt.com/c/completed-pro-response" } },
  });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: () => ({
      display: "none",
      visibility: "hidden",
      opacity: "0",
      pointerEvents: "none",
    }),
  });
  const tab = {
    playwright: {
      async evaluate<Result>(pageFunction: () => Result | Promise<Result>): Promise<Result> {
        return pageFunction();
      },
    },
  } as unknown as IabTab;

  try {
    const state = await readPageChatState(tab);
    assert.equal(state.isAnswering, false);
    assert.equal(state.assistantText, assistant.innerText);
    assert.equal(state.lastMessageRole, "assistant");
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

test("recognizes localized visible stop-answering controls without matching unrelated stops", async () => {
  let ariaLabel = "Stop answering";
  let buttonText = "Stop answering";
  const stopButton = {
    disabled: false,
    hidden: false,
    get textContent() {
      return buttonText;
    },
    getAttribute(name: string) {
      if (name === "aria-label") return ariaLabel;
      return null;
    },
    closest() {
      return null;
    },
    getBoundingClientRect() {
      return { width: 40, height: 40 };
    },
    getClientRects() {
      return [{}];
    },
  };
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const styleDescriptor = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      querySelectorAll(selector: string) {
        if (selector === "button") return [stopButton];
        return [];
      },
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { href: "https://chatgpt.com/c/active-pro-response" } },
  });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: () => ({
      display: "block",
      visibility: "visible",
      opacity: "1",
      pointerEvents: "auto",
    }),
  });
  const tab = {
    playwright: {
      async evaluate<Result>(pageFunction: () => Result | Promise<Result>): Promise<Result> {
        return pageFunction();
      },
    },
  } as unknown as IabTab;

  try {
    for (const label of [
      "Stop answering",
      "Stop generating",
      "Stop response",
      "停止產生",
      "停止回答",
      "停止回覆",
      "停止作答",
      "停止生成",
      "回答の生成を停止",
      "生成を停止する",
      "応答を停止",
      "생성 중지",
      "답변 중지",
      "응답 중지",
    ]) {
      ariaLabel = label;
      buttonText = label;
      assert.equal((await readPageChatState(tab)).isAnswering, true, label);
    }
    for (const label of ["Stop sharing", "停止錄音", "共有を停止", "녹음 중지"]) {
      ariaLabel = label;
      buttonText = label;
      assert.equal((await readPageChatState(tab)).isAnswering, false, label);
    }
    ariaLabel = "Stop sharing";
    buttonText = "Generating preview";
    assert.equal((await readPageChatState(tab)).isAnswering, false, "cross-field tokens");
    ariaLabel = "   ";
    buttonText = "Stop answering";
    assert.equal((await readPageChatState(tab)).isAnswering, true, "visible-text fallback");
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

test("ignores a dimensioned Stop button hidden by ancestor visibility", async () => {
  const stopButton = {
    disabled: false,
    hidden: false,
    textContent: "Stop answering",
    getAttribute(name: string) {
      if (name === "aria-label") return "Stop answering";
      return null;
    },
    closest() {
      return null;
    },
    checkVisibility() {
      return false;
    },
    getBoundingClientRect() {
      return { width: 40, height: 40 };
    },
    getClientRects() {
      return [{}];
    },
  };
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const styleDescriptor = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      querySelectorAll(selector: string) {
        if (selector === "button") return [stopButton];
        return [];
      },
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { href: "https://chatgpt.com/c/hidden-ancestor-response" } },
  });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: () => ({
      display: "block",
      visibility: "visible",
      opacity: "1",
      pointerEvents: "auto",
    }),
  });
  const tab = {
    playwright: {
      async evaluate<Result>(pageFunction: () => Result | Promise<Result>): Promise<Result> {
        return pageFunction();
      },
    },
  } as unknown as IabTab;

  try {
    assert.equal((await readPageChatState(tab)).isAnswering, false);
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

test("prefers the active injected Browser binding over a stale legacy iab binding", async () => {
  const active = fakeBrowser({
    states: [{ isAnswering: false, assistantText: "", assistantMessageCount: 0 }],
  }).browser;
  const stale = fakeBrowser({
    states: [{ isAnswering: false, assistantText: "", assistantMessageCount: 0 }],
  }).browser;
  const globals = globalThis as BrowserGlobals;
  const browserDescriptor = Object.getOwnPropertyDescriptor(globalThis, "browser");
  const iabDescriptor = Object.getOwnPropertyDescriptor(globalThis, "iab");
  globals.browser = active;
  globals.iab = stale;

  try {
    assert.equal(await resolveIabBrowser(), active);
  } finally {
    if (browserDescriptor) Object.defineProperty(globalThis, "browser", browserDescriptor);
    else delete globals.browser;
    if (iabDescriptor) Object.defineProperty(globalThis, "iab", iabDescriptor);
    else delete globals.iab;
  }
});

test("fills the ChatGPT composer and returns the completed assistant control text", async () => {
  const fixture = fakeBrowser({
    states: [
      { isAnswering: false, assistantText: "", assistantMessageCount: 0 },
      { isAnswering: true, assistantText: "working", assistantMessageCount: 0 },
      {
        isAnswering: false,
        assistantText: "done\n<CueLineControl>{\"action\":\"complete\"}</CueLineControl>",
        assistantMessageCount: 1,
      },
    ],
    submittedUrl: "https://chatgpt.com/c/controller-1",
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  const turn = await adapter.sendTurn({
    runId: "run_1",
    round: 1,
    requestId: "msg_1",
    prompt: "Controller prompt",
  });

  assert.deepEqual(fixture.composer.fills, ["Controller prompt"]);
  assert.match(turn.text, /<CueLineControl>/);
  assert.equal(turn.conversationUrl, "https://chatgpt.com/c/controller-1");
  assert.ok(
    fixture.requestedRoles.some(
      (request) => request.role === "textbox" && request.name === "Message ChatGPT",
    ),
  );
});

test("submitTurn returns after one durable submission without waiting for Pro", async () => {
  const fixture = fakeBrowser({
    states: [
      { isAnswering: false, assistantText: "", assistantMessageCount: 0 },
    ],
    submittedUrl: "https://chatgpt.com/c/detached-controller-wait",
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });
  const checkpoints: string[] = [];

  await adapter.submitTurn!(
    {
      runId: "run_detached_controller_wait",
      round: 1,
      requestId: "msg_detached_controller_wait",
      prompt: "Let Pro think beyond the outer waiter",
    },
    {
      async onCheckpoint(checkpoint) {
        checkpoints.push(checkpoint.submissionState);
      },
    },
  );

  assert.equal(fixture.sendSubmissions(), 1);
  assert.deepEqual(checkpoints, ["submitting", "submitted"]);
});

test("submitTurn waits for a delayed exact conversation URL after clicking only once", async () => {
  const conversationUrl = "https://chatgpt.com/c/delayed-conversation-url";
  const fixture = fakeBrowser({
    initialUrl: "https://chatgpt.com/",
    states: [{ isAnswering: false, assistantText: "", assistantMessageCount: 0 }],
    urlReadSequence: [
      "https://chatgpt.com/",
      "https://chatgpt.com/",
      conversationUrl,
      "https://chatgpt.com/c/unrelated-later-navigation",
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });
  const checkpoints: Array<{ state: string; url?: string }> = [];

  await adapter.submitTurn!(
    {
      runId: "run_delayed_conversation_url",
      round: 1,
      requestId: "msg_delayed_conversation_url",
      prompt: "Capture the exact URL without a second click",
    },
    {
      async onCheckpoint(checkpoint) {
        checkpoints.push({
          state: checkpoint.submissionState,
          ...(checkpoint.conversationUrl === undefined
            ? {}
            : { url: checkpoint.conversationUrl }),
        });
      },
    },
  );

  assert.equal(fixture.sendSubmissions(), 1);
  assert.deepEqual(checkpoints, [
    { state: "submitting" },
    { state: "submitted", url: conversationUrl },
  ]);
});

test("submitTurn refuses a post-click navigation away from an existing conversation", async () => {
  const conversationUrl = "https://chatgpt.com/c/existing-conversation-a";
  const navigatedUrl = "https://chatgpt.com/c/unrelated-conversation-b";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    states: [{ isAnswering: false, assistantText: "", assistantMessageCount: 0 }],
    urlReadSequence: [conversationUrl, conversationUrl, navigatedUrl],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });
  const checkpoints: Array<{ state: string; url?: string }> = [];

  await assert.rejects(
    adapter.submitTurn!(
      {
        runId: "run_existing_conversation_navigation",
        round: 2,
        requestId: "msg_existing_conversation_navigation",
        prompt: "Never bind a post-click navigation to the persisted run",
      },
      {
        async onCheckpoint(checkpoint) {
          checkpoints.push({
            state: checkpoint.submissionState,
            ...(checkpoint.conversationUrl === undefined
              ? {}
              : { url: checkpoint.conversationUrl }),
          });
        },
      },
    ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CONTROLLER_RECONCILIATION_CONVERSATION_MISMATCH" &&
      "details" in error &&
      (error.details as { submission_state?: unknown }).submission_state === "possibly_sent",
  );

  assert.equal(fixture.sendSubmissions(), 1);
  assert.deepEqual(checkpoints, [
    { state: "submitting", url: conversationUrl },
  ]);
});

test("submitTurn reports possibly sent when a new conversation never exposes an exact URL", async () => {
  const fixture = fakeBrowser({
    initialUrl: "https://chatgpt.com/",
    states: [{ isAnswering: false, assistantText: "", assistantMessageCount: 0 }],
    urlReadSequence: ["https://chatgpt.com/"],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 5,
  });

  await assert.rejects(
    adapter.submitTurn!({
      runId: "run_missing_conversation_url",
      round: 1,
      requestId: "msg_missing_conversation_url",
      prompt: "Never click twice when the URL is late",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CONTROLLER_CONVERSATION_URL_UNAVAILABLE" &&
      "details" in error &&
      (error.details as { submission_state?: unknown }).submission_state === "possibly_sent",
  );
  assert.equal(fixture.sendSubmissions(), 1);
});

test("observeTurn checks once without resending and later returns the exact completed Pro turn", async () => {
  const conversationUrl = "https://chatgpt.com/c/observed-controller-turn";
  const prompt = "Let Pro finish after the outer caller returns";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    submittedUrl: conversationUrl,
    initialModel: "Pro",
    states: [
      {
        isAnswering: false,
        assistantText: "",
        assistantMessageCount: 0,
      },
      {
        isAnswering: true,
        assistantText: "still thinking",
        assistantMessageCount: 0,
        lastUserText: prompt,
        lastMessageRole: "user",
      },
      {
        isAnswering: false,
        assistantText: "completed controller response",
        assistantMessageCount: 1,
        lastUserText: prompt,
        lastMessageRole: "assistant",
      },
      {
        isAnswering: false,
        assistantText: "completed controller response",
        assistantMessageCount: 1,
        lastUserText: prompt,
        lastMessageRole: "assistant",
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  await adapter.submitTurn!({
    runId: "run_observed_controller_turn",
    round: 1,
    requestId: "msg_observed_controller_turn",
    prompt,
  });
  const unfinished = await adapter.observeTurn!({
    runId: "run_observed_controller_turn",
    round: 1,
    requestId: "msg_observed_controller_turn",
    prompt,
  });
  const completed = await adapter.observeTurn!({
    runId: "run_observed_controller_turn",
    round: 1,
    requestId: "msg_observed_controller_turn",
    prompt,
  });

  assert.equal(unfinished, undefined);
  assert.equal(completed?.text, "completed controller response");
  assert.equal(completed?.conversationUrl, conversationUrl);
  assert.equal(fixture.sendSubmissions(), 1);
  assert.deepEqual(fixture.composer.fills, [prompt]);
  assert.equal(
    fixture.requestedRoles.some((request) =>
      /answer now|respond now|立即回答/i.test(request.name),
    ),
    false,
  );
});

test("returns the conversation URL captured with the completed response DOM", async () => {
  const responseUrl = "https://chatgpt.com/c/response-conversation";
  const fixture = fakeBrowser({
    states: [
      { isAnswering: false, assistantText: "", assistantMessageCount: 0 },
      { isAnswering: true, assistantText: "working", assistantMessageCount: 0 },
      {
        pageUrl: responseUrl,
        isAnswering: false,
        assistantText: "response from A",
        assistantMessageCount: 1,
      },
    ],
    // Simulate a navigation that a later tab.url() call would observe.
    submittedUrl: "https://chatgpt.com/c/later-conversation",
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  const turn = await adapter.sendTurn({
    runId: "run_same_dom_url",
    round: 1,
    requestId: "msg_same_dom_url",
    prompt: "Controller prompt",
  });

  assert.equal(turn.text, "response from A");
  assert.equal(turn.conversationUrl, responseUrl);
});

test("recognizes a long prompt converted to an attachment and clicks send exactly once", async () => {
  const fixture = fakeBrowser({
    composerStates: [
      {
        state: "empty",
        inlineTextLength: 0,
        attachmentCount: 0,
        sendButtonEnabled: false,
      },
      {
        state: "attachment_ready",
        inlineTextLength: 0,
        attachmentCount: 1,
        sendButtonEnabled: true,
      },
    ],
    states: [
      { isAnswering: false, assistantText: "", assistantMessageCount: 0 },
      { isAnswering: true, assistantText: "working", assistantMessageCount: 0 },
      { isAnswering: false, assistantText: "complete", assistantMessageCount: 1 },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });
  const checkpoints: string[] = [];

  const turn = await adapter.sendTurn(
    {
      runId: "run_attachment_ready",
      round: 1,
      requestId: "msg_attachment_ready",
      prompt: "x".repeat(44_679),
    },
    {
      async onCheckpoint(checkpoint) {
        checkpoints.push(`${checkpoint.submissionState}:${checkpoint.composerPromptState}`);
      },
    },
  );

  assert.equal(turn.text, "complete");
  assert.equal(fixture.sendButtons[0]?.clicks, 1);
  assert.equal(fixture.sendSubmissions(), 1);
  assert.deepEqual(checkpoints, [
    "submitting:attachment_ready",
    "submitted:attachment_ready",
  ]);
});

test("refuses an empty composer even when the send button is enabled", async () => {
  const fixture = fakeBrowser({
    composerStates: [
      { state: "empty", inlineTextLength: 0, attachmentCount: 0, sendButtonEnabled: true },
    ],
    states: [{ isAnswering: false, assistantText: "", assistantMessageCount: 0 }],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 20,
  });

  await assert.rejects(
    adapter.sendTurn({
      runId: "run_empty_enabled",
      round: 1,
      requestId: "msg_empty_enabled",
      prompt: "must exist before send",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CONTROLLER_PROMPT_NOT_READY" &&
      "details" in error &&
      typeof error.details === "object" &&
      error.details !== null &&
      (error.details as Record<string, unknown>).submission_state === "definitely_not_sent",
  );
  assert.equal(fixture.sendButtons[0]?.clicks, 0);
  assert.equal(fixture.sendSubmissions(), 0);
});

test("refuses a pre-existing attachment even if the current fill would add another", async () => {
  const fixture = fakeBrowser({
    composerStates: [
      {
        state: "attachment_ready",
        inlineTextLength: 0,
        attachmentCount: 1,
        sendButtonEnabled: true,
      },
      {
        state: "attachment_ready",
        inlineTextLength: 0,
        attachmentCount: 2,
        sendButtonEnabled: true,
      },
    ],
    states: [
      { isAnswering: false, assistantText: "", assistantMessageCount: 0 },
      { isAnswering: true, assistantText: "working", assistantMessageCount: 0 },
      { isAnswering: false, assistantText: "must not be accepted", assistantMessageCount: 1 },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 20,
  });

  await assert.rejects(
    adapter.sendTurn({
      runId: "run_preexisting_attachment",
      round: 1,
      requestId: "msg_preexisting_attachment",
      prompt: "new prompt must create new evidence",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CONTROLLER_PROMPT_NOT_READY" &&
      "details" in error &&
      typeof error.details === "object" &&
      error.details !== null &&
      (error.details as Record<string, unknown>).submission_state === "definitely_not_sent",
  );
  assert.deepEqual(fixture.composer.fills, []);
  assert.equal(fixture.sendButtons[0]?.clicks, 0);
  assert.equal(fixture.sendSubmissions(), 0);
});

test("does not classify an empty composer as unsent while an attachment is still settling", async () => {
  const fixture = fakeBrowser({
    composerStates: [
      { state: "empty", inlineTextLength: 0, attachmentCount: 0, sendButtonEnabled: false },
      {
        state: "attachment_ready",
        inlineTextLength: 0,
        attachmentCount: 1,
        sendButtonEnabled: true,
      },
    ],
    states: [
      { isAnswering: false, assistantText: "", assistantMessageCount: 0 },
      { isAnswering: true, assistantText: "working", assistantMessageCount: 0 },
      { isAnswering: false, assistantText: "complete", assistantMessageCount: 1 },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  await adapter.sendTurn({
    runId: "run_attachment_settling",
    round: 1,
    requestId: "msg_attachment_settling",
    prompt: "long prompt",
  });

  assert.equal(fixture.sendButtons[0]?.clicks, 1);
  assert.equal(fixture.sendSubmissions(), 1);
});

test("allows operator-confirmed attachment recovery without matching visible user text", async () => {
  const conversationUrl = "https://chatgpt.com/c/manual-attachment-recovery";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    initialModel: "Pro",
    states: [
      {
        isAnswering: false,
        assistantText: "previous unrelated response",
        assistantMessageCount: 1,
        lastUserText: "previous-user-message",
        lastMessageRole: "assistant",
      },
      {
        isAnswering: false,
        assistantText: "existing complete response",
        assistantMessageCount: 2,
        lastUserText: "controller-observation.txt",
        lastMessageRole: "assistant",
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  const turn = await adapter.recoverTurn!({
    runId: "run_manual_attachment",
    round: 2,
    requestId: "msg_manual_attachment",
    prompt: "x".repeat(44_679),
    manualSendConfirmed: true,
    baselineAssistantMessageCount: 1,
  });

  assert.equal(turn.text, "existing complete response");
  assert.equal(fixture.sendButtons[0]?.clicks, 0);
  assert.deepEqual(fixture.composer.fills, []);
});

test("allows a legacy operator-confirmed attachment recovery without a stored baseline", async () => {
  const conversationUrl = "https://chatgpt.com/c/manual-legacy-attachment-recovery";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    initialModel: "Pro",
    states: [
      {
        isAnswering: false,
        assistantText: `<CueLineControl>${JSON.stringify({
          protocol: "cueline/0.1",
          run_id: "run_manual_legacy_attachment",
          round: 2,
          request_id: "msg_manual_legacy_attachment",
          action: "complete",
          final_delivery_text: "legacy exact-envelope response",
        })}</CueLineControl>`,
        assistantMessageCount: 3,
        lastUserText: null,
        lastMessageRole: "assistant",
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  const turn = await adapter.recoverTurn!({
    runId: "run_manual_legacy_attachment",
    round: 2,
    requestId: "msg_manual_legacy_attachment",
    prompt: "x".repeat(44_679),
    manualSendConfirmed: true,
  });

  assert.match(turn.text, /legacy exact-envelope response/);
  assert.equal(fixture.sendButtons[0]?.clicks, 0);
  assert.deepEqual(fixture.composer.fills, []);
});

test("legacy manual recovery ignores an old assistant response until the exact envelope appears", async () => {
  const conversationUrl = "https://chatgpt.com/c/manual-legacy-race";
  const exactResponse = `<CueLineControl>${JSON.stringify({
    protocol: "cueline/0.1",
    run_id: "run_manual_legacy_race",
    round: 2,
    request_id: "msg_manual_legacy_race",
    action: "complete",
    final_delivery_text: "NEW_EXACT_RESPONSE",
  })}</CueLineControl>`;
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    initialModel: "Pro",
    states: [
      {
        isAnswering: false,
        assistantText: `<CueLineControl>${JSON.stringify({
          protocol: "cueline/0.1",
          run_id: "run_manual_legacy_race",
          round: 1,
          request_id: "msg_previous",
          action: "complete",
          final_delivery_text: "OLD_RESPONSE",
        })}</CueLineControl>`,
        assistantMessageCount: 1,
        lastUserText: "previous attachment",
        lastMessageRole: "assistant",
      },
      {
        isAnswering: false,
        assistantText: exactResponse,
        assistantMessageCount: 2,
        lastUserText: "controller-observation.txt",
        lastMessageRole: "assistant",
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  const turn = await adapter.recoverTurn!({
    runId: "run_manual_legacy_race",
    round: 2,
    requestId: "msg_manual_legacy_race",
    prompt: "x".repeat(44_679),
    manualSendConfirmed: true,
  });

  assert.equal(turn.text, exactResponse);
  assert.doesNotMatch(turn.text, /OLD_RESPONSE/);
  assert.equal(fixture.sendSubmissions(), 0);
});

test("recovers a CueLine-submitted attachment without requiring visible prompt equality", async () => {
  const conversationUrl = "https://chatgpt.com/c/automatic-attachment-recovery";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    initialModel: "Pro",
    states: [
      {
        isAnswering: false,
        assistantText: "existing attachment response",
        assistantMessageCount: 1,
        lastUserText: "controller-observation.txt",
        lastMessageRole: "assistant",
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  const turn = await adapter.recoverTurn!({
    runId: "run_automatic_attachment",
    round: 2,
    requestId: "msg_automatic_attachment",
    prompt: "x".repeat(44_679),
    attachmentPromptExpected: true,
    baselineAssistantMessageCount: 0,
  });

  assert.equal(turn.text, "existing attachment response");
  assert.equal(fixture.sendButtons[0]?.clicks, 0);
});

test("refuses attachment recovery without the pre-submit assistant baseline", async () => {
  const conversationUrl = "https://chatgpt.com/c/attachment-recovery-without-baseline";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    initialModel: "Pro",
    states: [
      {
        isAnswering: false,
        assistantText: "must not import without a baseline",
        assistantMessageCount: 1,
        lastUserText: "controller-observation.txt",
        lastMessageRole: "assistant",
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  await assert.rejects(
    adapter.recoverTurn!({
      runId: "run_attachment_without_baseline",
      round: 2,
      requestId: "msg_attachment_without_baseline",
      prompt: "x".repeat(44_679),
      attachmentPromptExpected: true,
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CONTROLLER_RECONCILIATION_BASELINE_REQUIRED",
  );
  assert.deepEqual(fixture.composer.fills, []);
  assert.equal(fixture.sendButtons[0]?.clicks, 0);
});

test("fills the hydrated contenteditable composer instead of the pre-hydration textbox", async () => {
  const fixture = fakeBrowser({
    states: [
      { isAnswering: false, assistantText: "", assistantMessageCount: 0 },
      { isAnswering: true, assistantText: "working", assistantMessageCount: 0 },
      { isAnswering: false, assistantText: "complete", assistantMessageCount: 1 },
    ],
    hydratedComposer: true,
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  const turn = await adapter.sendTurn({
    runId: "run_hydrated",
    round: 1,
    requestId: "msg_hydrated",
    prompt: "Use the visible editor",
  });

  assert.deepEqual(fixture.hydratedComposer.fills, ["Use the visible editor"]);
  assert.deepEqual(fixture.composer.fills, []);
  assert.deepEqual(fixture.requestedSelectors, ['#prompt-textarea[contenteditable="true"]']);
  assert.equal(turn.text, "complete");
});

test("refuses to reacquire a send button after an unverified click failure", async () => {
  const fixture = fakeBrowser({
    states: [
      { isAnswering: false, assistantText: "", assistantMessageCount: 0 },
      { isAnswering: false, assistantText: "", assistantMessageCount: 0 },
      { isAnswering: false, assistantText: "complete", assistantMessageCount: 1 },
    ],
    failFirstClick: true,
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  await assert.rejects(
    adapter.sendTurn({
      runId: "run_1",
      round: 1,
      requestId: "msg_1",
      prompt: "Retry safely",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CONTROLLER_SUBMISSION_AMBIGUOUS" &&
      "details" in error &&
      typeof error.details === "object" &&
      error.details !== null &&
      (error.details as Record<string, unknown>).submission_state === "possibly_sent",
  );

  assert.equal(fixture.sendButtons[0]?.clicks, 1);
  assert.equal(fixture.sendButtons[1]?.clicks, 0);
  assert.equal(fixture.coordinateClicks(), 0);
});

test("a failed post-click submitted checkpoint never triggers another click", async () => {
  const fixture = fakeBrowser({
    states: [
      { isAnswering: false, assistantText: "", assistantMessageCount: 0 },
      { isAnswering: true, assistantText: "working", assistantMessageCount: 0 },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 100,
  });

  await assert.rejects(
    adapter.sendTurn(
      {
        runId: "run_submitted_checkpoint_failure",
        round: 1,
        requestId: "msg_submitted_checkpoint_failure",
        prompt: "Click only once",
      },
      {
        async onCheckpoint(checkpoint) {
          if (checkpoint.submissionState === "submitted") {
            throw new Error("submitted checkpoint persistence failed");
          }
        },
      },
    ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "IAB_READ_FAILED_AFTER_SUBMIT" &&
      "details" in error &&
      typeof error.details === "object" &&
      error.details !== null &&
      (error.details as Record<string, unknown>).submission_state === "submitted",
  );
  assert.equal(fixture.sendButtons[0]?.clicks, 1);
  assert.equal(fixture.sendButtons[1]?.clicks, 0);
  assert.equal(fixture.sendSubmissions(), 1);
  assert.equal(fixture.coordinateClicks(), 0);
});

test("uses the visible send coordinate only when no locator click was attempted", async () => {
  const fixture = fakeBrowser({
    states: [
      { isAnswering: false, assistantText: "", assistantMessageCount: 0 },
      { isAnswering: true, assistantText: "working", assistantMessageCount: 0 },
      { isAnswering: false, assistantText: "complete", assistantMessageCount: 1 },
    ],
    sendButtonAvailable: false,
    cuaAvailable: true,
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  const turn = await adapter.sendTurn({
    runId: "run_coordinate_fallback",
    round: 1,
    requestId: "msg_coordinate_fallback",
    prompt: "Submit through the visible button",
  });

  assert.equal(fixture.sendButtons[0]?.clicks, 0);
  assert.equal(fixture.coordinateClicks(), 1);
  assert.equal(fixture.sendSubmissions(), 1);
  assert.equal(turn.text, "complete");
});

test("classifies a missing send target as definitely not sent when no click was attempted", async () => {
  const fixture = fakeBrowser({
    states: [{ isAnswering: false, assistantText: "", assistantMessageCount: 0 }],
    sendButtonAvailable: false,
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  await assert.rejects(
    adapter.sendTurn({
      runId: "run_missing_send_target",
      round: 1,
      requestId: "msg_missing_send_target",
      prompt: "No click means definitely not sent",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "SEND_BUTTON_MISSING" &&
      "details" in error &&
      typeof error.details === "object" &&
      error.details !== null &&
      (error.details as Record<string, unknown>).submission_state === "definitely_not_sent",
  );

  assert.equal(fixture.sendButtons[0]?.clicks, 0);
  assert.equal(fixture.coordinateClicks(), 0);
  assert.equal(fixture.sendSubmissions(), 0);
});

test("classifies an unverified coordinate click as ambiguous without retrying", async () => {
  const fixture = fakeBrowser({
    states: [
      { isAnswering: false, assistantText: "", assistantMessageCount: 0 },
      { isAnswering: false, assistantText: "", assistantMessageCount: 0 },
    ],
    sendButtonAvailable: false,
    cuaAvailable: true,
    coordinateClickError: "Timed out clicking the visible coordinate",
    coordinateClickSubmitsBeforeThrow: true,
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  await assert.rejects(
    adapter.sendTurn({
      runId: "run_coordinate_ambiguous",
      round: 1,
      requestId: "msg_coordinate_ambiguous",
      prompt: "Never repeat a coordinate click",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CONTROLLER_SUBMISSION_AMBIGUOUS",
  );

  assert.equal(fixture.coordinateClicks(), 1);
  assert.equal(fixture.sendSubmissions(), 1);
});

test("does not retry a timed-out click when answering already started", async () => {
  const fixture = fakeBrowser({
    states: [
      { isAnswering: false, assistantText: "", assistantMessageCount: 0 },
      { isAnswering: true, assistantText: "started", assistantMessageCount: 0 },
      { isAnswering: false, assistantText: "finished", assistantMessageCount: 1 },
    ],
    failFirstClick: true,
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  const turn = await adapter.sendTurn({
    runId: "run_1",
    round: 1,
    requestId: "msg_1",
    prompt: "Avoid duplicate send",
  });

  assert.equal(fixture.sendButtons[0]?.clicks, 1);
  assert.equal(fixture.sendButtons[1]?.clicks, 0);
  assert.equal(turn.text, "finished");
});

test("a completed response proves a timed-out click submitted on an existing conversation", async () => {
  const conversationUrl = "https://chatgpt.com/c/fast-click-completion";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    states: [
      {
        isAnswering: false,
        assistantText: "previous",
        assistantMessageCount: 1,
      },
      {
        isAnswering: false,
        assistantText: "fast complete",
        assistantMessageCount: 2,
      },
    ],
    failFirstClick: true,
    firstSendClickSubmitsBeforeThrow: true,
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  const turn = await adapter.sendTurn({
    runId: "run_fast_click_completion",
    round: 2,
    requestId: "msg_fast_click_completion",
    prompt: "Accept the one completed response",
  });

  assert.equal(turn.text, "fast complete");
  assert.equal(fixture.sendButtons[0]?.clicks, 1);
  assert.equal(fixture.sendButtons[1]?.clicks, 0);
  assert.equal(fixture.coordinateClicks(), 0);
  assert.equal(fixture.sendSubmissions(), 1);
});

test("a response count from another conversation cannot prove a timed-out click submitted", async () => {
  const originalUrl = "https://chatgpt.com/c/click-proof-original";
  const fixture = fakeBrowser({
    initialUrl: originalUrl,
    states: [
      {
        pageUrl: originalUrl,
        isAnswering: false,
        assistantText: "previous",
        assistantMessageCount: 1,
      },
      {
        pageUrl: "https://chatgpt.com/c/click-proof-unrelated",
        isAnswering: false,
        assistantText: "unrelated complete",
        assistantMessageCount: 2,
      },
    ],
    failFirstClick: true,
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl: originalUrl,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  await assert.rejects(
    adapter.sendTurn({
      runId: "run_click_proof_unrelated",
      round: 2,
      requestId: "msg_click_proof_unrelated",
      prompt: "Do not import another conversation",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CONTROLLER_SUBMISSION_AMBIGUOUS",
  );

  assert.equal(fixture.sendButtons[0]?.clicks, 1);
  assert.equal(fixture.sendButtons[1]?.clicks, 0);
  assert.equal(fixture.coordinateClicks(), 0);
});

test("does not send twice when an ambiguous locator failure hides a successful click", async () => {
  const fixture = fakeBrowser({
    states: [
      { isAnswering: false, assistantText: "", assistantMessageCount: 0 },
      { isAnswering: false, assistantText: "", assistantMessageCount: 0 },
      { isAnswering: false, assistantText: "", assistantMessageCount: 0 },
      { isAnswering: true, assistantText: "working", assistantMessageCount: 0 },
      { isAnswering: false, assistantText: "complete", assistantMessageCount: 1 },
    ],
    failFirstClick: true,
    firstSendClickSubmitsBeforeThrow: true,
    cuaAvailable: true,
    firstClickError: "Timed out running CDP command Runtime.evaluate",
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  await assert.rejects(
    adapter.sendTurn({
      runId: "run_ambiguous_click",
      round: 1,
      requestId: "msg_ambiguous_click",
      prompt: "Never duplicate this prompt",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CONTROLLER_SUBMISSION_AMBIGUOUS",
  );

  assert.equal(fixture.sendButtons[0]?.clicks, 1);
  assert.equal(fixture.sendButtons[1]?.clicks, 0);
  assert.equal(fixture.coordinateClicks(), 0);
  assert.equal(fixture.sendSubmissions(), 1);
});

test("treats an unreadable post-click state as ambiguous without another click", async () => {
  const fixture = fakeBrowser({
    states: [
      { isAnswering: false, assistantText: "", assistantMessageCount: 0 },
      { isAnswering: true, assistantText: "started", assistantMessageCount: 0 },
      { isAnswering: false, assistantText: "finished", assistantMessageCount: 1 },
    ],
    failFirstClick: true,
    failStateReadAt: 1,
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  await assert.rejects(
    adapter.sendTurn({
      runId: "run_transient",
      round: 1,
      requestId: "msg_transient",
      prompt: "Recover without duplicate send",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CONTROLLER_SUBMISSION_AMBIGUOUS",
  );

  assert.equal(fixture.sendButtons[0]?.clicks, 1);
  assert.equal(fixture.sendButtons[1]?.clicks, 0);
  assert.equal(fixture.coordinateClicks(), 0);
});

test("does not mistake the previous stable assistant message for the new response", async () => {
  const fixture = fakeBrowser({
    states: [
      { isAnswering: false, assistantText: "previous", assistantMessageCount: 1 },
      { isAnswering: false, assistantText: "previous", assistantMessageCount: 1 },
      { isAnswering: true, assistantText: "new partial", assistantMessageCount: 1 },
      { isAnswering: false, assistantText: "new complete", assistantMessageCount: 2 },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  const turn = await adapter.sendTurn({
    runId: "run_stale",
    round: 2,
    requestId: "msg_stale",
    prompt: "Wait for the next message",
  });

  assert.equal(turn.text, "new complete");
});

test("switches the composer to Pro before sending and reports verified model evidence", async () => {
  const fixture = fakeBrowser({
    initialModel: "Instant",
    states: [
      { isAnswering: false, assistantText: "", assistantMessageCount: 0 },
      { isAnswering: true, assistantText: "working", assistantMessageCount: 0 },
      { isAnswering: false, assistantText: "complete", assistantMessageCount: 1 },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  const turn = await adapter.sendTurn({
    runId: "run_pro",
    round: 1,
    requestId: "msg_pro",
    prompt: "Use Pro",
  });

  assert.equal(fixture.modelPicker.clicks, 1);
  assert.equal(fixture.proOption.clicks, 1);
  assert.deepEqual(
    (turn as unknown as { model?: unknown }).model,
    {
      provider: "chatgpt",
      selectedLabel: "Pro",
      responseModelSlug: "gpt-5-6-pro",
      source: "composer_and_response",
    },
  );
});

test("refuses to send when the Pro model option is unavailable", async () => {
  const fixture = fakeBrowser({
    initialModel: "Instant",
    proOptionAvailable: false,
    states: [
      { isAnswering: false, assistantText: "", assistantMessageCount: 0 },
      { isAnswering: true, assistantText: "working", assistantMessageCount: 0 },
      { isAnswering: false, assistantText: "complete", assistantMessageCount: 1 },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  await assert.rejects(
    adapter.sendTurn({
      runId: "run_no_pro",
      round: 1,
      requestId: "msg_no_pro",
      prompt: "Do not downgrade",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "PRO_MODEL_UNAVAILABLE",
  );
  assert.deepEqual(fixture.composer.fills, []);
});

test("refuses to send when the composer model selector cannot be identified", async () => {
  const fixture = fakeBrowser({
    initialModel: null,
    states: [{ isAnswering: false, assistantText: "", assistantMessageCount: 0 }],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  await assert.rejects(
    adapter.sendTurn({
      runId: "run_missing_model_selector",
      round: 1,
      requestId: "msg_missing_model_selector",
      prompt: "Require visible Pro evidence",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "MODEL_SELECTOR_MISSING" &&
      "details" in error &&
      (error.details as { submission_state?: unknown; request_id?: unknown })
        .submission_state === "definitely_not_sent" &&
      (error.details as { submission_state?: unknown; request_id?: unknown }).request_id ===
        "msg_missing_model_selector",
  );
  assert.deepEqual(fixture.composer.fills, []);
});

test("refuses to send when selecting Pro does not change the composer model", async () => {
  const fixture = fakeBrowser({
    initialModel: "Instant",
    proSelectionSucceeds: false,
    states: [{ isAnswering: false, assistantText: "", assistantMessageCount: 0 }],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  await assert.rejects(
    adapter.sendTurn({
      runId: "run_pro_selection_failed",
      round: 1,
      requestId: "msg_pro_selection_failed",
      prompt: "Require Pro",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "PRO_MODEL_SELECTION_FAILED",
  );
  assert.equal(fixture.proOption.clicks, 1);
  assert.deepEqual(fixture.composer.fills, []);
});

test("rejects a response whose actual model slug is not Pro", async () => {
  const fixture = fakeBrowser({
    initialModel: "Pro",
    responseModelSlug: "not-pro-model",
    states: [
      { isAnswering: false, assistantText: "", assistantMessageCount: 0 },
      { isAnswering: true, assistantText: "working", assistantMessageCount: 0 },
      { isAnswering: false, assistantText: "complete", assistantMessageCount: 1 },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  await assert.rejects(
    adapter.sendTurn({
      runId: "run_fallback",
      round: 1,
      requestId: "msg_fallback",
      prompt: "Require actual Pro",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "PRO_MODEL_MISMATCH",
  );
});

test("waits for the Pro composer label to hydrate before sending", async () => {
  const fixture = fakeBrowser({
    initialModel: "Pro",
    modelReadSequence: [null, "Pro"],
    states: [
      { isAnswering: false, assistantText: "", assistantMessageCount: 0 },
      { isAnswering: true, assistantText: "working", assistantMessageCount: 0 },
      { isAnswering: false, assistantText: "complete", assistantMessageCount: 1 },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  const turn = await adapter.sendTurn({
    runId: "run_hydrating_pro_before_send",
    round: 1,
    requestId: "msg_hydrating_pro_before_send",
    prompt: "Wait for the actual Pro composer before sending",
  });

  assert.equal(turn.text, "complete");
  assert.equal(fixture.sendSubmissions(), 1);
  assert.deepEqual(fixture.composer.fills, ["Wait for the actual Pro composer before sending"]);
});

test("reacquires the exact conversation once when the cached tab is gone", async () => {
  const conversationUrl = "https://chatgpt.com/c/controller-recovery";
  const healthy = fakeBrowser({
    initialUrl: conversationUrl,
    states: [
      { isAnswering: false, assistantText: "", assistantMessageCount: 0 },
      { isAnswering: true, assistantText: "working", assistantMessageCount: 0 },
      { isAnswering: false, assistantText: "complete", assistantMessageCount: 1 },
    ],
  });
  const staleTab: IabTab = {
    async goto() {},
    async url() {
      return conversationUrl;
    },
    playwright: {
      getByRole() {
        return new FakeLocator();
      },
      async evaluate() {
        throw new Error("Tab not found: 1. Existing tabs: none");
      },
      async domSnapshot() {
        throw new Error("Tab not found: 1. Existing tabs: none");
      },
      async waitForTimeout() {},
    },
  };
  let selectedCalls = 0;
  let getCalls = 0;
  const browser: IabBrowser = {
    async documentation() {},
    tabs: {
      async new() {
        return healthy.tab;
      },
      async selected() {
        selectedCalls += 1;
        return selectedCalls === 1 ? staleTab : undefined;
      },
      async list() {
        return [{ id: "healthy", url: conversationUrl }];
      },
      async get() {
        getCalls += 1;
        return healthy.tab;
      },
    },
  };
  const adapter = createCodexIabAdapter({
    browser,
    conversationUrl,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  const turn = await adapter.sendTurn({
    runId: "run_recover",
    round: 2,
    requestId: "msg_recover",
    prompt: "Continue the same run",
  });

  assert.equal(getCalls, 1);
  assert.equal(turn.conversationUrl, conversationUrl);
  assert.equal(turn.text, "complete");
});

test("reattaches and waits without resending when the tab disappears during submission", async () => {
  const conversationUrl = "https://chatgpt.com/c/controller-submission-recovery";
  const submitting = fakeBrowser({
    initialUrl: conversationUrl,
    failFirstClick: true,
    firstClickError: "Tab not found: 1. Existing tabs: none",
    failStateReadAt: 1,
    states: [{ isAnswering: false, assistantText: "", assistantMessageCount: 0 }],
  });
  const recovered = fakeBrowser({
    initialUrl: conversationUrl,
    states: [
      { isAnswering: true, assistantText: "working", assistantMessageCount: 0 },
      { isAnswering: false, assistantText: "complete", assistantMessageCount: 1 },
    ],
  });
  let selectedCalls = 0;
  let getCalls = 0;
  const browser: IabBrowser = {
    async documentation() {},
    tabs: {
      async new() {
        return recovered.tab;
      },
      async selected() {
        selectedCalls += 1;
        return selectedCalls === 1 ? submitting.tab : undefined;
      },
      async list() {
        return [{ id: "recovered", url: conversationUrl }];
      },
      async get() {
        getCalls += 1;
        return recovered.tab;
      },
    },
  };
  const adapter = createCodexIabAdapter({
    browser,
    conversationUrl,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  const turn = await adapter.sendTurn({
    runId: "run_submission_recover",
    round: 2,
    requestId: "msg_submission_recover",
    prompt: "Do not send twice",
  });

  assert.equal(getCalls, 1);
  assert.deepEqual(submitting.composer.fills, ["Do not send twice"]);
  assert.deepEqual(recovered.composer.fills, []);
  assert.equal(turn.text, "complete");
});

test("refuses recovery when the tab disappears before an exact conversation URL is known", async () => {
  const fixture = fakeBrowser({
    failFirstClick: true,
    firstClickError: "Tab not found: 1. Existing tabs: none",
    failStateReadAt: 1,
    states: [{ isAnswering: false, assistantText: "", assistantMessageCount: 0 }],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  await assert.rejects(
    adapter.sendTurn({
      runId: "run_unknown_conversation_recovery",
      round: 1,
      requestId: "msg_unknown_conversation_recovery",
      prompt: "Never duplicate this prompt",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "TAB_RECOVERY_UNSAFE",
  );
  assert.deepEqual(fixture.composer.fills, ["Never duplicate this prompt"]);
  assert.equal(fixture.sendButtons[0]!.clicks, 1);
  assert.equal(fixture.sendButtons[1]!.clicks, 0);
});

test("refuses recovery when submission cannot be proven after reattaching", async () => {
  const conversationUrl = "https://chatgpt.com/c/controller-unsafe-recovery";
  const submitting = fakeBrowser({
    initialUrl: conversationUrl,
    failFirstClick: true,
    firstClickError: "Tab not found: 1. Existing tabs: none",
    failStateReadAt: 1,
    states: [{ isAnswering: false, assistantText: "", assistantMessageCount: 0 }],
  });
  const recovered = fakeBrowser({
    initialUrl: conversationUrl,
    states: [{ isAnswering: false, assistantText: "", assistantMessageCount: 0 }],
  });
  let selectedCalls = 0;
  let getCalls = 0;
  const browser: IabBrowser = {
    async documentation() {},
    tabs: {
      async new() {
        return recovered.tab;
      },
      async selected() {
        selectedCalls += 1;
        return selectedCalls === 1 ? submitting.tab : undefined;
      },
      async list() {
        return [{ id: "recovered", url: conversationUrl }];
      },
      async get() {
        getCalls += 1;
        return recovered.tab;
      },
    },
  };
  const adapter = createCodexIabAdapter({
    browser,
    conversationUrl,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  await assert.rejects(
    adapter.sendTurn({
      runId: "run_unproven_submission",
      round: 2,
      requestId: "msg_unproven_submission",
      prompt: "Never resend after an ambiguous click",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "TAB_RECOVERY_UNSAFE",
  );
  assert.equal(getCalls, 1);
  assert.deepEqual(submitting.composer.fills, ["Never resend after an ambiguous click"]);
  assert.deepEqual(recovered.composer.fills, []);
});

test("retries a transient selected-tab attach failure before creating a tab", async () => {
  const fixture = fakeBrowser({
    states: [
      { isAnswering: false, assistantText: "", assistantMessageCount: 0 },
      { isAnswering: true, assistantText: "working", assistantMessageCount: 0 },
      { isAnswering: false, assistantText: "complete", assistantMessageCount: 1 },
    ],
  });
  let selectedCalls = 0;
  let newCalls = 0;
  const browser: IabBrowser = {
    async documentation() {},
    tabs: {
      async selected() {
        selectedCalls += 1;
        if (selectedCalls === 1) throw new Error("Browser webview attach timeout");
        return fixture.tab;
      },
      async new() {
        newCalls += 1;
        throw new Error("UNEXPECTED_NEW_TAB");
      },
    },
  };
  const adapter = createCodexIabAdapter({
    browser,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  const turn = await adapter.sendTurn({
    runId: "run_attach_retry",
    round: 1,
    requestId: "msg_attach_retry",
    prompt: "Retry discovery only",
  });

  assert.equal(turn.text, "complete");
  assert.equal(selectedCalls, 2);
  assert.equal(newCalls, 0);
});

test("does not reinterpret a persistent tab-list attach failure as an empty list", async () => {
  let listCalls = 0;
  let newCalls = 0;
  const browser: IabBrowser = {
    async documentation() {},
    tabs: {
      async selected() {
        return undefined;
      },
      async list() {
        listCalls += 1;
        throw new Error("Browser webview attach timeout");
      },
      async new() {
        newCalls += 1;
        throw new Error("UNEXPECTED_NEW_TAB");
      },
    },
  };
  const adapter = createCodexIabAdapter({ browser, timeoutMs: 1_000 });

  await assert.rejects(
    adapter.sendTurn({
      runId: "run_attach_failure",
      round: 1,
      requestId: "msg_attach_failure",
      prompt: "Do not create from an unknown discovery failure",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "IAB_ATTACH_FAILED",
  );
  assert.equal(listCalls, 2);
  assert.equal(newCalls, 0);
});

test("retries a new tab that disappears before load and caches only the healthy tab", async () => {
  const healthy = fakeBrowser({
    states: [
      { isAnswering: false, assistantText: "", assistantMessageCount: 0 },
      { isAnswering: true, assistantText: "working", assistantMessageCount: 0 },
      { isAnswering: false, assistantText: "complete", assistantMessageCount: 1 },
    ],
  });
  const vanished: IabTab = {
    async goto() {},
    async url() {
      return "https://chatgpt.com/";
    },
    playwright: {
      getByRole() {
        return new FakeLocator();
      },
      async evaluate<Result>() {
        return null as Result;
      },
      async domSnapshot() {
        return {};
      },
      async waitForTimeout() {},
      async waitForLoadState() {
        throw new Error("Target closed while attaching webview");
      },
    },
  };
  let newCalls = 0;
  const browser: IabBrowser = {
    async documentation() {},
    tabs: {
      async new() {
        newCalls += 1;
        return newCalls === 1 ? vanished : healthy.tab;
      },
    },
  };
  const adapter = createCodexIabAdapter({
    browser,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  const turn = await adapter.sendTurn({
    runId: "run_new_tab_retry",
    round: 1,
    requestId: "msg_new_tab_retry",
    prompt: "Retry before submit",
  });

  assert.equal(turn.text, "complete");
  assert.equal(newCalls, 2);
  assert.deepEqual(healthy.composer.fills, ["Retry before submit"]);
});

test("recovers an existing completed response from the exact conversation without sending", async () => {
  const conversationUrl = "https://chatgpt.com/c/existing-response";
  const prompt = "Existing controller prompt";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    initialModel: "Pro",
    states: [
      {
        isAnswering: false,
        assistantText: "existing complete response",
        assistantMessageCount: 1,
        lastUserText: prompt,
        lastMessageRole: "assistant",
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  const turn = await adapter.recoverTurn!({
    runId: "run_existing_response",
    round: 1,
    requestId: "msg_existing_response",
    prompt,
  });

  assert.equal(turn?.text, "existing complete response");
  assert.equal(turn?.conversationUrl, conversationUrl);
  assert.deepEqual(fixture.composer.fills, []);
  assert.equal(fixture.sendButtons[0]!.clicks, 0);
});

test("recovery ignores a stale selected webview and claims the exact user conversation", async () => {
  const conversationUrl = "https://chatgpt.com/c/claimed-existing-response";
  const prompt = "Claim the exact completed controller conversation";
  const healthy = fakeBrowser({
    initialUrl: conversationUrl,
    initialModel: "Pro",
    states: [
      {
        isAnswering: false,
        assistantText: "claimed complete response",
        assistantMessageCount: 1,
        lastUserText: prompt,
        lastMessageRole: "assistant",
      },
    ],
  });
  const staleSelected: IabTab = {
    async goto() {},
    async url() {
      throw new Error("Timed out waiting for the Browser webview to attach");
    },
    playwright: healthy.tab.playwright,
  };
  let claimCalls = 0;
  let newCalls = 0;
  const browser: IabBrowser = {
    async documentation() {},
    tabs: {
      async selected() {
        return staleSelected;
      },
      async list() {
        return [];
      },
      async new() {
        newCalls += 1;
        throw new Error("UNEXPECTED_NEW_TAB");
      },
    },
    user: {
      async openTabs() {
        return [{ id: "user-conversation", url: conversationUrl }];
      },
      async claimTab() {
        claimCalls += 1;
        return healthy.tab;
      },
    },
  };
  const adapter = createCodexIabAdapter({
    browser,
    conversationUrl,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  const turn = await adapter.recoverTurn!({
    runId: "run_claimed_existing_response",
    round: 1,
    requestId: "msg_claimed_existing_response",
    prompt,
  });

  assert.equal(turn.text, "claimed complete response");
  assert.equal(turn.conversationUrl, conversationUrl);
  assert.equal(claimCalls, 1);
  assert.equal(newCalls, 0);
  assert.deepEqual(healthy.composer.fills, []);
});

test("refuses recovery when response evidence and URL come from different DOM snapshots", async () => {
  const conversationUrl = "https://chatgpt.com/c/exact-conversation";
  const prompt = "Existing controller prompt";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    initialModel: "Pro",
    states: [
      {
        pageUrl: "https://chatgpt.com/c/different-conversation",
        isAnswering: false,
        assistantText: "must not import",
        assistantMessageCount: 1,
        lastUserText: prompt,
        lastMessageRole: "assistant",
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  await assert.rejects(
    adapter.recoverTurn!({
      runId: "run_cross_dom_response",
      round: 1,
      requestId: "msg_cross_dom_response",
      prompt,
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CONTROLLER_RECONCILIATION_CONVERSATION_MISMATCH",
  );
  assert.deepEqual(fixture.composer.fills, []);
  assert.equal(fixture.sendButtons[0]!.clicks, 0);
});

test("waits for the Pro model button to hydrate before reconciling", async () => {
  const conversationUrl = "https://chatgpt.com/c/hydrating-pro-button";
  const prompt = "Existing controller prompt";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    initialModel: "Pro",
    modelReadSequence: [null, "Pro"],
    states: [
      {
        isAnswering: false,
        assistantText: "existing complete response",
        assistantMessageCount: 1,
        lastUserText: prompt,
        lastMessageRole: "assistant",
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  const turn = await adapter.recoverTurn!({
    runId: "run_hydrating_pro_button",
    round: 1,
    requestId: "msg_hydrating_pro_button",
    prompt,
  });

  assert.equal(turn.text, "existing complete response");
  assert.deepEqual(fixture.composer.fills, []);
  assert.equal(fixture.sendButtons[0]!.clicks, 0);
});

test("waits for the existing user prompt to hydrate before reconciling", async () => {
  const conversationUrl = "https://chatgpt.com/c/hydrating-user-prompt";
  const prompt = "Existing controller prompt";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    initialModel: "Pro",
    states: [
      {
        isAnswering: false,
        assistantText: "",
        assistantMessageCount: 0,
        lastUserText: null,
        lastMessageRole: null,
      },
      {
        isAnswering: false,
        assistantText: "existing complete response",
        assistantMessageCount: 1,
        lastUserText: prompt,
        lastMessageRole: "assistant",
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  const turn = await adapter.recoverTurn!({
    runId: "run_hydrating_user_prompt",
    round: 1,
    requestId: "msg_hydrating_user_prompt",
    prompt,
  });

  assert.equal(turn.text, "existing complete response");
  assert.deepEqual(fixture.composer.fills, []);
  assert.equal(fixture.sendButtons[0]!.clicks, 0);
});

test("still refuses recovery when neither model picker nor Pro button is visible", async () => {
  const conversationUrl = "https://chatgpt.com/c/unverified-model";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    initialModel: "Pro",
    legacyModelPickerPresent: false,
    states: [
      {
        isAnswering: false,
        assistantText: "must not import",
        assistantMessageCount: 1,
        lastUserText: "Expected prompt",
        lastMessageRole: "assistant",
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  await assert.rejects(
    adapter.recoverTurn!({
      runId: "run_unverified_model",
      round: 1,
      requestId: "msg_unverified_model",
      prompt: "Expected prompt",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CONTROLLER_RECONCILIATION_MODEL_UNVERIFIED",
  );
  assert.deepEqual(fixture.composer.fills, []);
  assert.equal(fixture.sendButtons[0]!.clicks, 0);
});

test("refuses to reconcile a response when the last user prompt does not match", async () => {
  const conversationUrl = "https://chatgpt.com/c/wrong-response";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    initialModel: "Pro",
    states: [
      {
        isAnswering: false,
        assistantText: "reply to another prompt",
        assistantMessageCount: 1,
        lastUserText: "Different prompt",
        lastMessageRole: "assistant",
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  await assert.rejects(
    adapter.recoverTurn!({
      runId: "run_wrong_response",
      round: 1,
      requestId: "msg_wrong_response",
      prompt: "Expected prompt",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CONTROLLER_RECONCILIATION_MISMATCH",
  );
  assert.deepEqual(fixture.composer.fills, []);
  assert.equal(fixture.sendButtons[0]!.clicks, 0);
});

test("classifies an unexpected browser read failure after submission", async () => {
  const fixture = fakeBrowser({
    initialUrl: "https://chatgpt.com/c/read-failure",
    initialModel: "Pro",
    failStateReadAt: 1,
    stateReadError: "Unexpected IAB bridge failure",
    states: [{ isAnswering: false, assistantText: "", assistantMessageCount: 0 }],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl: "https://chatgpt.com/c/read-failure",
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  await assert.rejects(
    adapter.sendTurn({
      runId: "run_read_failure",
      round: 1,
      requestId: "msg_read_failure",
      prompt: "Classify the browser failure",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "IAB_READ_FAILED_AFTER_SUBMIT" &&
      "details" in error &&
      (error.details as { submission_state?: unknown }).submission_state === "submitted",
  );
});

test("classifies a failed write-ahead checkpoint as definitely not sent", async () => {
  const fixture = fakeBrowser({
    initialUrl: "https://chatgpt.com/c/checkpoint-failure",
    initialModel: "Pro",
    states: [{ isAnswering: false, assistantText: "", assistantMessageCount: 0 }],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl: "https://chatgpt.com/c/checkpoint-failure",
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  await assert.rejects(
    adapter.sendTurn(
      {
        runId: "run_checkpoint_failure",
        round: 1,
        requestId: "msg_checkpoint_failure",
        prompt: "Do not click without a durable checkpoint",
      },
      {
        async onCheckpoint() {
          throw new Error("event log fsync failed");
        },
      },
    ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "IAB_ATTACH_FAILED" &&
      "details" in error &&
      (error.details as { submission_state?: unknown }).submission_state ===
        "definitely_not_sent",
  );
  assert.deepEqual(fixture.composer.fills, ["Do not click without a durable checkpoint"]);
  assert.equal(fixture.sendButtons[0]!.clicks, 0);
});
