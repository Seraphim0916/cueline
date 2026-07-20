import assert from "node:assert/strict";
import test from "node:test";

import { createCodexIabAdapter } from "../../src/browser/codex-iab/chatgpt-client.js";
import type {
  BrowserAdapter,
  BrowserTurnInput,
  ControllerTurn,
} from "../../src/browser/browser-adapter.js";
import { CueLineError } from "../../src/core/errors.js";
import { commandHash } from "../../src/core/ids.js";
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
import { acquireChatGptTab } from "../../src/browser/codex-iab/tab-discovery.js";
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
  hangClick = false;
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
    if (this.hangClick) {
      await new Promise<never>(() => {});
    }
    if (this.failFirstClick && this.clicks === 1) {
      if (this.invokeOnClickBeforeFailure) this.onClick?.();
      throw new Error(this.firstClickError);
    }
    this.onClick?.();
  }
}

test("rejects a non-conversation URL before touching the Browser runtime", () => {
  let browserTouched = false;
  const browser: IabBrowser = {
    async documentation() {
      browserTouched = true;
    },
    tabs: {
      async new() {
        browserTouched = true;
        throw new Error("BROWSER_MUST_NOT_BE_TOUCHED");
      },
    },
  };

  assert.throws(
    () =>
      createCodexIabAdapter({
        browser,
        conversationUrl: "https://chatgpt.com/c/real-id/not-the-conversation",
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CONTROLLER_RECONCILIATION_URL_REQUIRED",
  );
  assert.equal(browserTouched, false);
});

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
  hangSendClick?: boolean;
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
  archivePostActionUrl?: string;
  archiveClickError?: string;
  archiveClickChangesUrlBeforeThrow?: boolean;
  archiveButtonAvailable?: boolean;
  archiveMenuItemAvailable?: boolean;
  accessibilitySnapshots?: string[];
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
  const conversationOptionsButton = new FakeLocator();
  const missingConversationOptionsButton = new FakeLocator();
  missingConversationOptionsButton.countResult = 0;
  const archiveMenuItem = new FakeLocator(() => {
    url = options.archivePostActionUrl ?? "https://chatgpt.com/";
  });
  const missingArchiveMenuItem = new FakeLocator();
  missingArchiveMenuItem.countResult = 0;
  if (options.archiveClickError) {
    archiveMenuItem.failFirstClick = true;
    archiveMenuItem.firstClickError = options.archiveClickError;
    archiveMenuItem.invokeOnClickBeforeFailure =
      options.archiveClickChangesUrlBeforeThrow ?? false;
  }
  sendButtons[0]!.failFirstClick = options.failFirstClick ?? false;
  sendButtons[0]!.invokeOnClickBeforeFailure =
    options.firstSendClickSubmitsBeforeThrow ?? false;
  sendButtons[0]!.firstClickError = options.firstClickError ?? sendButtons[0]!.firstClickError;
  for (const sendButton of sendButtons) {
    sendButton.hangClick = options.hangSendClick ?? false;
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
  let accessibilitySnapshotRead = 0;
  let hangUrlReads = false;

  const playwright = {
    locator(selector: string) {
      requestedSelectors.push(selector);
      if (selector === "button.__composer-pill") return modelPicker;
      if (selector === '[data-testid="conversation-options-button"]') {
        return options.archiveButtonAvailable === false
          ? missingConversationOptionsButton
          : conversationOptionsButton;
      }
      return options.hydratedComposer ? hydratedComposer : missingHydratedComposer;
    },
    getByRole(role: string, query: { name: string }) {
      requestedRoles.push({ role, name: query.name });
      if (role === "textbox") return composer;
      if (role === "menuitemradio" && query.name === "Pro") {
        return options.proOptionAvailable === false ? missingProOption : proOption;
      }
      if (role === "menuitem" && (query.name === "Archive" || query.name === "封存")) {
        return options.archiveMenuItemAvailable === false
          ? missingArchiveMenuItem
          : archiveMenuItem;
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
      const snapshots = options.accessibilitySnapshots ?? [];
      const snapshot = snapshots[
        Math.min(accessibilitySnapshotRead, Math.max(0, snapshots.length - 1))
      ];
      accessibilitySnapshotRead += 1;
      return snapshot ?? {};
    },
    async waitForTimeout() {},
  };

  const tab: IabTab = {
    async goto(nextUrl) {
      url = nextUrl;
    },
    async url() {
      if (hangUrlReads) {
        return new Promise<string>(() => {});
      }
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
    conversationOptionsButton,
    archiveMenuItem,
    hangFutureUrlReads: () => {
      hangUrlReads = true;
    },
    coordinateClicks: () => coordinateClicks,
    sendSubmissions: () => sendSubmissions,
    accessibilitySnapshotReads: () => accessibilitySnapshotRead,
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

test("archives one exact completed conversation with one Archive click", async () => {
  const conversationUrl = "https://chatgpt.com/c/archive-browser-adapter";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    archivePostActionUrl: "https://chatgpt.com/",
    states: [
      {
        pageUrl: conversationUrl,
        isAnswering: false,
        assistantText: "complete",
        assistantMessageCount: 1,
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    timeoutMs: 20,
    pollIntervalMs: 1,
  });

  const evidence = await adapter.archiveConversation!({ conversationUrl });

  assert.equal(fixture.conversationOptionsButton.clicks, 1);
  assert.equal(fixture.archiveMenuItem.clicks, 1);
  assert.deepEqual(evidence, {
    conversationUrl,
    proof: "conversation_url_changed",
    postActionUrl: "https://chatgpt.com/",
  });
});

test("an ambiguous Archive click is never retried", async () => {
  const conversationUrl = "https://chatgpt.com/c/archive-browser-ambiguous";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    archiveClickError: "Playwright timeout after Archive click",
    states: [
      {
        pageUrl: conversationUrl,
        isAnswering: false,
        assistantText: "complete",
        assistantMessageCount: 1,
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    timeoutMs: 5,
    pollIntervalMs: 1,
  });

  await assert.rejects(
    adapter.archiveConversation!({ conversationUrl }),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "CONTROLLER_CONVERSATION_ARCHIVE_AMBIGUOUS",
  );
  assert.equal(fixture.archiveMenuItem.clicks, 1);
});

test("a timed-out Archive click is accepted only when URL change proves completion", async () => {
  const conversationUrl = "https://chatgpt.com/c/archive-browser-timeout-proven";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    archiveClickError: "Playwright timeout after accepted Archive click",
    archiveClickChangesUrlBeforeThrow: true,
    states: [
      {
        pageUrl: conversationUrl,
        isAnswering: false,
        assistantText: "complete",
        assistantMessageCount: 1,
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    timeoutMs: 5,
    pollIntervalMs: 1,
  });

  const evidence = await adapter.archiveConversation!({ conversationUrl });

  assert.equal(evidence.proof, "conversation_url_changed");
  assert.equal(fixture.archiveMenuItem.clicks, 1);
});

test("refuses to archive a conversation other than the adapter binding", async () => {
  const conversationUrl = "https://chatgpt.com/c/archive-browser-bound";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    states: [
      {
        pageUrl: conversationUrl,
        isAnswering: false,
        assistantText: "complete",
        assistantMessageCount: 1,
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    timeoutMs: 5,
    pollIntervalMs: 1,
  });

  await assert.rejects(
    adapter.archiveConversation!({
      conversationUrl: "https://chatgpt.com/c/archive-browser-other",
    }),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "CONTROLLER_CONVERSATION_ARCHIVE_MISMATCH",
  );
  assert.equal(fixture.conversationOptionsButton.clicks, 0);
  assert.equal(fixture.archiveMenuItem.clicks, 0);
});

test("never opens archive controls while ChatGPT Pro is answering", async () => {
  const conversationUrl = "https://chatgpt.com/c/archive-pro-active";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    states: [
      {
        pageUrl: conversationUrl,
        isAnswering: true,
        assistantText: "still answering",
        assistantMessageCount: 1,
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    timeoutMs: 5,
    pollIntervalMs: 1,
  });

  await assert.rejects(
    adapter.archiveConversation!({ conversationUrl }),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "CONTROLLER_CONVERSATION_ARCHIVE_PRO_ACTIVE",
  );
  assert.equal(fixture.conversationOptionsButton.clicks, 0);
  assert.equal(fixture.archiveMenuItem.clicks, 0);
});

test("never clicks Archive when Pro starts answering after the menu opens", async () => {
  const conversationUrl = "https://chatgpt.com/c/archive-pro-restarted";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    states: [
      {
        pageUrl: conversationUrl,
        isAnswering: false,
        assistantText: "complete",
        assistantMessageCount: 1,
      },
      {
        pageUrl: conversationUrl,
        isAnswering: true,
        assistantText: "new answer",
        assistantMessageCount: 1,
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    timeoutMs: 5,
    pollIntervalMs: 1,
  });

  await assert.rejects(
    adapter.archiveConversation!({ conversationUrl }),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "CONTROLLER_CONVERSATION_ARCHIVE_PRO_ACTIVE",
  );
  assert.equal(fixture.conversationOptionsButton.clicks, 1);
  assert.equal(fixture.archiveMenuItem.clicks, 0);
});

test("never clicks Archive when the tab navigates after the menu opens", async () => {
  const conversationUrl = "https://chatgpt.com/c/archive-navigation-race";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    states: [
      {
        pageUrl: conversationUrl,
        isAnswering: false,
        assistantText: "complete",
        assistantMessageCount: 1,
      },
      {
        pageUrl: "https://chatgpt.com/c/different-conversation",
        isAnswering: false,
        assistantText: "different conversation",
        assistantMessageCount: 1,
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    timeoutMs: 5,
    pollIntervalMs: 1,
  });

  await assert.rejects(
    adapter.archiveConversation!({ conversationUrl }),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "CONTROLLER_CONVERSATION_ARCHIVE_MISMATCH",
  );
  assert.equal(fixture.conversationOptionsButton.clicks, 1);
  assert.equal(fixture.archiveMenuItem.clicks, 0);
});

test("never clicks Archive when cancellation arrives at the write-ahead checkpoint", async () => {
  const conversationUrl = "https://chatgpt.com/c/archive-cancelled-at-checkpoint";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    states: [
      {
        pageUrl: conversationUrl,
        isAnswering: false,
        assistantText: "complete",
        assistantMessageCount: 1,
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    timeoutMs: 5,
    pollIntervalMs: 1,
  });
  const controller = new AbortController();

  await assert.rejects(
    adapter.archiveConversation!(
      { conversationUrl, signal: controller.signal },
      {
        async onBeforeArchiveClick() {
          controller.abort();
        },
      },
    ),
  );
  assert.equal(fixture.conversationOptionsButton.clicks, 1);
  assert.equal(fixture.archiveMenuItem.clicks, 0);
});

test("never clicks Archive when Pro starts answering during the durable checkpoint", async () => {
  const conversationUrl = "https://chatgpt.com/c/archive-pro-active-during-checkpoint";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    states: [
      {
        pageUrl: conversationUrl,
        isAnswering: false,
        assistantText: "complete",
        assistantMessageCount: 1,
      },
      {
        pageUrl: conversationUrl,
        isAnswering: false,
        assistantText: "complete",
        assistantMessageCount: 1,
      },
      {
        pageUrl: conversationUrl,
        isAnswering: true,
        assistantText: "new response started",
        assistantMessageCount: 1,
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    timeoutMs: 5,
    pollIntervalMs: 1,
  });
  let checkpoints = 0;

  await assert.rejects(
    adapter.archiveConversation!(
      { conversationUrl },
      {
        async onBeforeArchiveClick() {
          checkpoints += 1;
        },
      },
    ),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "CONTROLLER_CONVERSATION_ARCHIVE_PRO_ACTIVE",
  );
  assert.equal(checkpoints, 1);
  assert.equal(fixture.archiveMenuItem.clicks, 0);
});

test("normalizes contenteditable block newlines without erasing indentation", async () => {
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

    composer.innerText = "Run exactly:\nnpm test";
    composer.textContent = composer.innerText;
    const indentationMismatch = await readPageComposerState(
      tab,
      "Run exactly:\n  npm test",
      ["Send prompt"],
    );
    assert.equal(indentationMismatch.state, "empty");
    assert.equal(indentationMismatch.sendButtonEnabled, true);
  } finally {
    if (documentDescriptor) {
      Object.defineProperty(globalThis, "document", documentDescriptor);
    } else {
      delete (globalThis as { document?: unknown }).document;
    }
  }
});

test("composer readiness ignores every non-actionable residual Send button", async () => {
  type VisibilityCase =
    | "hidden"
    | "aria_hidden"
    | "ancestor_hidden"
    | "check_visibility"
    | "display"
    | "visibility"
    | "opacity"
    | "pointer_events"
    | "geometry"
    | "client_rects"
    | "visible";
  let visibilityCase: VisibilityCase = "visible";
  const sendButton = {
    disabled: false,
    get hidden() {
      return visibilityCase === "hidden";
    },
    innerText: "Send prompt",
    textContent: "Send prompt",
    getAttribute(name: string) {
      if (name === "aria-label") return "Send prompt";
      if (name === "aria-disabled") return "false";
      if (name === "aria-hidden") return visibilityCase === "aria_hidden" ? "true" : null;
      return null;
    },
    closest() {
      return visibilityCase === "ancestor_hidden" ? this : null;
    },
    checkVisibility() {
      return visibilityCase !== "check_visibility";
    },
    getBoundingClientRect() {
      return visibilityCase === "geometry"
        ? { width: 0, height: 0 }
        : { width: 40, height: 40 };
    },
    getClientRects() {
      return visibilityCase === "client_rects" ? [] : [{}];
    },
  };
  const form = {
    querySelectorAll(selector: string) {
      return selector === "button" ? [sendButton] : [];
    },
  };
  const composer = {
    innerText: "controller prompt",
    textContent: "controller prompt",
    parentElement: null,
    closest() {
      return form;
    },
  };
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const styleDescriptor = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { querySelector: () => composer },
  });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: () => ({
      display: visibilityCase === "display" ? "none" : "block",
      visibility: visibilityCase === "visibility" ? "hidden" : "visible",
      opacity: visibilityCase === "opacity" ? "0" : "1",
      pointerEvents: visibilityCase === "pointer_events" ? "none" : "auto",
    }),
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
    for (const candidate of [
      "hidden",
      "aria_hidden",
      "ancestor_hidden",
      "check_visibility",
      "display",
      "visibility",
      "opacity",
      "pointer_events",
      "geometry",
      "client_rects",
    ] as const) {
      visibilityCase = candidate;
      const state = await readPageComposerState(tab, "controller prompt", ["Send prompt"]);
      assert.equal(state.state, "inline_ready");
      assert.equal(state.sendButtonEnabled, false, candidate);
    }
    visibilityCase = "visible";
    assert.equal(
      (await readPageComposerState(tab, "controller prompt", ["Send prompt"]))
        .sendButtonEnabled,
      true,
    );
  } finally {
    for (const [name, descriptor] of [
      ["document", documentDescriptor],
      ["getComputedStyle", styleDescriptor],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
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
      { isAnswering: true, assistantText: "working", assistantMessageCount: 0 },
    ],
    urlReadSequence: [
      "https://chatgpt.com/",
      "https://chatgpt.com/c/detached-controller-wait",
    ],
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

test("submission checkpoints include prompt identity, user baseline, click phase, and DOM evidence", async () => {
  const fixture = fakeBrowser({
    initialUrl: "https://chatgpt.com/c/checkpoint-evidence",
    states: [
      { isAnswering: false, assistantText: "previous", assistantMessageCount: 1 },
      { isAnswering: true, assistantText: "working", assistantMessageCount: 1 },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl: "https://chatgpt.com/c/checkpoint-evidence",
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });
  const checkpoints: Array<Record<string, unknown>> = [];
  const prompt = "Persist exact click evidence";

  await adapter.submitTurn!(
    {
      runId: "run_checkpoint_evidence",
      round: 1,
      requestId: "msg_checkpoint_evidence",
      prompt,
    },
    {
      async onCheckpoint(checkpoint) {
        checkpoints.push(checkpoint as unknown as Record<string, unknown>);
      },
    },
  );

  assert.equal(checkpoints.length, 2);
  assert.deepEqual(
    checkpoints.map((checkpoint) => checkpoint.clickAttemptState),
    ["attempting", "accepted"],
  );
  assert.equal(checkpoints[0]?.runId, "run_checkpoint_evidence");
  assert.equal(checkpoints[0]?.round, 1);
  assert.equal(checkpoints[0]?.requestId, "msg_checkpoint_evidence");
  assert.equal(checkpoints[0]?.promptHash, commandHash(prompt));
  assert.equal(checkpoints[0]?.modelEvidenceSource, "composer");
  assert.equal(checkpoints[0]?.baselineUserMessageCount, 0);
  assert.equal(checkpoints[0]?.baselineAssistantMessageCount, 1);
  assert.deepEqual(checkpoints[1]?.domEvidence, {
    pageUrl: "https://chatgpt.com/c/checkpoint-evidence",
    userMessageCount: 0,
    assistantMessageCount: 1,
    lastMessageRole: "assistant",
    lastUserMessageHash: null,
    isAnswering: true,
  });
});

test("a resolved click with an unchanged staged attachment is definitely not sent", async () => {
  const conversationUrl = "https://chatgpt.com/c/post-click-noop";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    hydratedComposer: true,
    composerStates: [
      { state: "empty", inlineTextLength: 0, attachmentCount: 0, sendButtonEnabled: false },
      {
        state: "attachment_ready",
        inlineTextLength: 0,
        attachmentCount: 1,
        sendButtonEnabled: true,
      },
      {
        state: "attachment_ready",
        inlineTextLength: 0,
        attachmentCount: 1,
        sendButtonEnabled: true,
      },
    ],
    states: [
      {
        pageUrl: conversationUrl,
        isAnswering: false,
        assistantText: "",
        userMessageCount: 0,
        assistantMessageCount: 0,
        lastUserText: null,
        lastMessageRole: null,
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 20,
  });
  const checkpoints: string[] = [];

  await assert.rejects(
    adapter.submitTurn!(
      {
        runId: "run_post_click_noop",
        round: 87,
        requestId: "msg_post_click_noop",
        prompt: "x".repeat(44_679),
      },
      {
        async onCheckpoint(checkpoint) {
          checkpoints.push(checkpoint.submissionState);
        },
      },
    ),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "CONTROLLER_PROMPT_NOT_SENT" &&
      (error.details as Record<string, unknown>).submission_state ===
        "definitely_not_sent",
  );

  assert.equal(fixture.sendButtons[0]?.clicks, 1);
  assert.equal(fixture.sendSubmissions(), 1);
  assert.deepEqual(checkpoints, ["submitting"]);
});

test("post-click acknowledgement emits submitted once when the exact user request appears", async () => {
  const conversationUrl = "https://chatgpt.com/c/post-click-exact-request";
  const prompt = "Exact request acknowledgement";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    states: [
      {
        pageUrl: conversationUrl,
        isAnswering: false,
        assistantText: "",
        userMessageCount: 0,
        assistantMessageCount: 0,
      },
      {
        pageUrl: conversationUrl,
        isAnswering: false,
        assistantText: "",
        userMessageCount: 1,
        assistantMessageCount: 0,
        lastUserText: prompt,
        lastMessageRole: "user",
      },
    ],
    composerStates: [
      { state: "empty", inlineTextLength: 0, attachmentCount: 0, sendButtonEnabled: false },
      { state: "inline_ready", inlineTextLength: prompt.length, attachmentCount: 0, sendButtonEnabled: true },
      { state: "inline_ready", inlineTextLength: prompt.length, attachmentCount: 0, sendButtonEnabled: true },
      { state: "empty", inlineTextLength: 0, attachmentCount: 0, sendButtonEnabled: false },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 20,
  });
  const checkpoints: string[] = [];

  await adapter.submitTurn!(
    { runId: "run_post_click_exact", round: 1, requestId: "msg_exact", prompt },
    { async onCheckpoint(checkpoint) { checkpoints.push(checkpoint.submissionState); } },
  );

  assert.deepEqual(checkpoints, ["submitting", "submitted"]);
});

test("post-click acknowledgement accepts a removed attachment only when submission also started", async () => {
  const conversationUrl = "https://chatgpt.com/c/post-click-attachment-accepted";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    hydratedComposer: true,
    states: [
      { pageUrl: conversationUrl, isAnswering: false, assistantText: "", userMessageCount: 3, assistantMessageCount: 1 },
      { pageUrl: conversationUrl, isAnswering: true, assistantText: "", userMessageCount: 3, assistantMessageCount: 1 },
    ],
    composerStates: [
      { state: "empty", inlineTextLength: 0, attachmentCount: 0, sendButtonEnabled: false },
      { state: "attachment_ready", inlineTextLength: 0, attachmentCount: 1, sendButtonEnabled: true },
      { state: "attachment_ready", inlineTextLength: 0, attachmentCount: 1, sendButtonEnabled: true },
      { state: "empty", inlineTextLength: 0, attachmentCount: 0, sendButtonEnabled: false },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 20,
  });
  const checkpoints: string[] = [];

  await adapter.submitTurn!(
    { runId: "run_attachment_ack", round: 1, requestId: "msg_attachment_ack", prompt: "x".repeat(44_679) },
    { async onCheckpoint(checkpoint) { checkpoints.push(checkpoint.submissionState); } },
  );

  assert.deepEqual(checkpoints, ["submitting", "submitted"]);
});

test("a removed attachment without request or answering evidence stays possibly sent", async () => {
  const conversationUrl = "https://chatgpt.com/c/post-click-attachment-ambiguous";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    hydratedComposer: true,
    states: [
      { pageUrl: conversationUrl, isAnswering: false, assistantText: "", userMessageCount: 3, assistantMessageCount: 1 },
    ],
    composerStates: [
      { state: "empty", inlineTextLength: 0, attachmentCount: 0, sendButtonEnabled: false },
      { state: "attachment_ready", inlineTextLength: 0, attachmentCount: 1, sendButtonEnabled: true },
      { state: "attachment_ready", inlineTextLength: 0, attachmentCount: 1, sendButtonEnabled: true },
      { state: "empty", inlineTextLength: 0, attachmentCount: 0, sendButtonEnabled: false },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 20,
  });
  const checkpoints: string[] = [];

  await assert.rejects(
    adapter.submitTurn!(
      { runId: "run_attachment_ambiguous", round: 1, requestId: "msg_attachment_ambiguous", prompt: "x".repeat(44_679) },
      { async onCheckpoint(checkpoint) { checkpoints.push(checkpoint.submissionState); } },
    ),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "CONTROLLER_SUBMISSION_AMBIGUOUS" &&
      (error.details as Record<string, unknown>).submission_state === "possibly_sent",
  );

  assert.equal(fixture.sendButtons[0]?.clicks, 1);
  assert.deepEqual(checkpoints, ["submitting", "possibly_sent"]);
});

test("operator-confirmed not-sent retry fails closed when the abandoned user message appears before retry click", async () => {
  const conversationUrl = "https://chatgpt.com/c/not-sent-conflict";
  const prompt = "Original controller prompt";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    states: [
      {
        isAnswering: false,
        assistantText: "previous",
        assistantMessageCount: 1,
        userMessageCount: 2,
        lastUserText: prompt,
        lastMessageRole: "user",
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
  const input = {
    runId: "run_not_sent_conflict",
    round: 2,
    requestId: "msg_retry",
    prompt: prompt.replace("Original", "Retry"),
    notSentRecovery: {
      abandonedRequestId: "msg_original",
      promptHash: commandHash(prompt),
      conversationUrl,
      baselineUserMessageCount: 1,
    },
  } as BrowserTurnInput & {
    notSentRecovery: {
      abandonedRequestId: string;
      promptHash: string;
      conversationUrl: string;
      baselineUserMessageCount: number;
    };
  };

  await assert.rejects(
    adapter.sendTurn(input),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "CONTROLLER_NOT_SENT_CONFIRMATION_CONFLICT",
  );
  assert.equal(fixture.composer.fills.length, 0);
  assert.equal(fixture.sendButtons[0]?.clicks, 0);
});

test("operator-confirmed not-sent retry freezes when the abandoned user message appears after the retry click", async () => {
  const conversationUrl = "https://chatgpt.com/c/not-sent-late-conflict";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    states: [
      {
        isAnswering: false,
        assistantText: "previous",
        assistantMessageCount: 1,
        userMessageCount: 1,
        lastUserText: "previous prompt",
        lastMessageRole: "assistant",
      },
      {
        isAnswering: true,
        assistantText: "",
        assistantMessageCount: 1,
        userMessageCount: 3,
        lastUserText: "abandoned prompt appeared late",
        lastMessageRole: "user",
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
    adapter.sendTurn({
      runId: "run_not_sent_late_conflict",
      round: 2,
      requestId: "msg_retry",
      prompt: "retry prompt",
      notSentRecovery: {
        abandonedRequestId: "msg_original",
        promptHash: commandHash("abandoned prompt appeared late"),
        conversationUrl,
        baselineUserMessageCount: 1,
      },
    }),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "CONTROLLER_NOT_SENT_CONFIRMATION_CONFLICT",
  );
  assert.equal(fixture.sendButtons[0]?.clicks, 1);
  assert.equal(fixture.sendSubmissions(), 1);
});

test("submitTurn waits for a delayed exact conversation URL after clicking only once", async () => {
  const conversationUrl = "https://chatgpt.com/c/delayed-conversation-url";
  const fixture = fakeBrowser({
    initialUrl: "https://chatgpt.com/",
    states: [
      { isAnswering: false, assistantText: "", assistantMessageCount: 0 },
      { isAnswering: true, assistantText: "working", assistantMessageCount: 0 },
    ],
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

test("submitTurn accepts an equivalent trailing-slash conversation URL", async () => {
  const conversationUrl = "https://chatgpt.com/c/existing-canonical-conversation";
  const equivalentUrl = `${conversationUrl}/?utm_source=cueline#latest`;
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    states: [
      { isAnswering: false, assistantText: "", assistantMessageCount: 0 },
      { isAnswering: true, assistantText: "working", assistantMessageCount: 0 },
    ],
    urlReadSequence: [conversationUrl, equivalentUrl],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });
  const checkpoints: Array<{ state: string; url?: string }> = [];

  await adapter.submitTurn!(
    {
      runId: "run_existing_canonical_conversation",
      round: 2,
      requestId: "msg_existing_canonical_conversation",
      prompt: "Keep the same canonical conversation",
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
    { state: "submitting", url: conversationUrl },
    { state: "submitted", url: conversationUrl },
  ]);
});

test("submitTurn refuses a post-click navigation away from an existing conversation", async () => {
  const conversationUrl = "https://chatgpt.com/c/existing-conversation-a";
  const navigatedUrl = "https://chatgpt.com/c/unrelated-conversation-b";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    states: [{ isAnswering: false, assistantText: "", assistantMessageCount: 0 }],
    urlReadSequence: [conversationUrl, navigatedUrl],
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

test("submitTurn never binds a nested path that only starts like a conversation URL", async () => {
  const fixture = fakeBrowser({
    initialUrl: "https://chatgpt.com/",
    states: [{ isAnswering: false, assistantText: "", assistantMessageCount: 0 }],
    urlReadSequence: [
      "https://chatgpt.com/",
      "https://chatgpt.com/",
      "https://chatgpt.com/c/real-conversation/not-the-conversation",
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 5,
  });

  await assert.rejects(
    adapter.submitTurn!({
      runId: "run_nested_conversation_path",
      round: 1,
      requestId: "msg_nested_conversation_path",
      prompt: "Never bind a URL prefix",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CONTROLLER_CONVERSATION_URL_UNAVAILABLE",
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
    stableMs: 1,
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

test("submitted-turn observation waits past an initial 0/0 page before classifying not sent", async () => {
  const conversationUrl = "https://chatgpt.com/c/submitted-turn-hydration";
  const prompt = "Round 34 prompt absent after restart";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    initialModel: "Pro",
    hydratedComposer: true,
    states: [
      {
        isAnswering: false,
        assistantText: "",
        userMessageCount: 0,
        assistantMessageCount: 0,
      },
      {
        isAnswering: false,
        assistantText: "",
        userMessageCount: 0,
        assistantMessageCount: 0,
      },
      {
        isAnswering: false,
        assistantText: "round 33 response",
        userMessageCount: 50,
        assistantMessageCount: 49,
        lastUserText: "round 33 prompt",
        lastMessageRole: "assistant",
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    timeoutMs: 50,
    pollIntervalMs: 1,
    stableMs: 0,
  }) as BrowserAdapter & {
    observeSubmittedTurn(input: BrowserTurnInput): Promise<{
      status: string;
      evidence?: { hydrated: boolean; observedUserMessageCount: number | null };
    }>;
  };

  assert.equal(typeof adapter.observeSubmittedTurn, "function");
  const observation = await adapter.observeSubmittedTurn({
    runId: "run_submitted_turn_hydration",
    round: 34,
    requestId: "msg_submitted_turn_hydration",
    prompt,
    baselineUserMessageCount: 50,
    baselineAssistantMessageCount: 49,
  } as BrowserTurnInput & { baselineUserMessageCount: number });

  assert.equal(observation.status, "definitely_not_sent");
  assert.equal(observation.evidence?.hydrated, true);
  assert.equal(observation.evidence?.observedUserMessageCount, 50);
});

test("submitted-turn observation refuses an unhydrated zero-count page", async () => {
  const conversationUrl = "https://chatgpt.com/c/submitted-turn-unhydrated";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    initialModel: "Pro",
    hydratedComposer: true,
    states: [
      {
        isAnswering: false,
        assistantText: "",
        userMessageCount: 0,
        assistantMessageCount: 0,
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    timeoutMs: 5,
    pollIntervalMs: 1,
    stableMs: 0,
  }) as BrowserAdapter & {
    observeSubmittedTurn(input: BrowserTurnInput): Promise<{
      status: string;
      evidence?: { hydrated: boolean; observedUserMessageCount: number | null };
    }>;
  };

  assert.equal(typeof adapter.observeSubmittedTurn, "function");
  const observation = await adapter.observeSubmittedTurn({
    runId: "run_submitted_turn_unhydrated",
    round: 34,
    requestId: "msg_submitted_turn_unhydrated",
    prompt: "Never classify the first empty read",
    baselineUserMessageCount: 50,
    baselineAssistantMessageCount: 49,
  } as BrowserTurnInput & { baselineUserMessageCount: number });

  assert.equal(observation.status, "pending");
  assert.equal(observation.evidence?.hydrated, false);
  assert.equal(observation.evidence?.observedUserMessageCount, 0);
});

test("submitted-turn recovery accepts only an exact round 94 envelope from the accessibility snapshot when message counts regress to zero", async () => {
  const conversationUrl = "https://chatgpt.com/c/round-94-virtualized-recovery";
  const runId = "run_round_94_virtualized_recovery";
  const requestId = "msg_round_94_virtualized_recovery";
  const response = `<CueLineControl>${JSON.stringify({
    protocol: "cueline/0.1",
    run_id: runId,
    round: 94,
    request_id: requestId,
    action: "dispatch",
    jobs: [
      {
        job_key: "round_94_follow_up",
        lane: "default",
        mode: "advise",
        task: "Continue only after the recovered response is durable",
      },
    ],
  })}</CueLineControl>`;
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    initialModel: "Pro",
    hydratedComposer: true,
    states: [
      {
        isAnswering: false,
        assistantText: "",
        userMessageCount: 0,
        assistantMessageCount: 0,
        assistantModelSlug: "gpt-5-6-pro",
        lastUserText: null,
        lastMessageRole: null,
      },
    ],
    composerStates: [
      {
        state: "empty",
        inlineTextLength: 0,
        attachmentCount: 0,
        sendButtonEnabled: false,
      },
    ],
    accessibilitySnapshots: [
      `- main:\n  - article:\n    - heading "ChatGPT said:"\n    - paragraph: ${JSON.stringify(response)}`,
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    timeoutMs: 20,
    pollIntervalMs: 1,
    stableMs: 0,
  });

  const observation = await adapter.observeSubmittedTurn!({
    runId,
    round: 94,
    requestId,
    prompt: "round 94 prompt hidden by ChatGPT virtualization",
    baselineUserMessageCount: 111,
    baselineAssistantMessageCount: 94,
  });

  assert.equal(observation.status, "response");
  assert.equal(observation.status === "response" ? observation.turn.text : null, response);
  assert.equal(
    observation.status === "response" ? observation.responseSource : null,
    "count_degraded_accessibility_exact_envelope",
  );
  assert.equal(fixture.sendSubmissions(), 0);
  assert.deepEqual(fixture.composer.fills, []);
  assert.equal(fixture.accessibilitySnapshotReads(), 1);
});

test("submitted-turn recovery does not treat unrelated accessibility text as the current response", async () => {
  const conversationUrl = "https://chatgpt.com/c/round-94-accessibility-negative";
  const runId = "run_round_94_accessibility_negative";
  const requestId = "msg_round_94_accessibility_negative";
  const userPromptEnvelope = `<CueLineControl>${JSON.stringify({
    protocol: "cueline/0.1",
    run_id: runId,
    round: 94,
    request_id: requestId,
    action: "dispatch",
    jobs: [],
  })}</CueLineControl>`;
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    initialModel: "Pro",
    hydratedComposer: true,
    states: [
      {
        isAnswering: false,
        assistantText: "",
        userMessageCount: 0,
        assistantMessageCount: 0,
        assistantModelSlug: "gpt-5-6-pro",
      },
    ],
    composerStates: [
      {
        state: "empty",
        inlineTextLength: 0,
        attachmentCount: 0,
        sendButtonEnabled: false,
      },
    ],
    accessibilitySnapshots: [
      `- main:\n  - article "You said":\n    - paragraph: ChatGPT, inspect this exact prompt only\n    - paragraph: ${JSON.stringify(userPromptEnvelope)}`,
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    timeoutMs: 5,
    pollIntervalMs: 1,
    stableMs: 0,
  });

  const observation = await adapter.observeSubmittedTurn!({
    runId,
    round: 94,
    requestId,
    prompt: "never import unrelated accessibility text",
    baselineUserMessageCount: 111,
    baselineAssistantMessageCount: 94,
  });

  assert.equal(observation.status, "pending");
  assert.equal(fixture.sendSubmissions(), 0);
});

test("submitted attachment observation requires the residual staged attachment", async () => {
  const conversationUrl = "https://chatgpt.com/c/submitted-attachment-no-residual";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    initialModel: "Pro",
    hydratedComposer: true,
    states: [
      {
        isAnswering: false,
        assistantText: "round 84 response",
        userMessageCount: 101,
        assistantMessageCount: 16,
        lastUserText: "round 84 attachment",
        lastMessageRole: "assistant",
      },
    ],
    composerStates: [
      {
        state: "empty",
        inlineTextLength: 0,
        attachmentCount: 0,
        sendButtonEnabled: false,
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    timeoutMs: 5,
    pollIntervalMs: 1,
    stableMs: 0,
  });

  const observation = await adapter.observeSubmittedTurn!({
    runId: "run_submitted_attachment_no_residual",
    round: 85,
    requestId: "msg_submitted_attachment_no_residual",
    prompt: "round 85 attachment prompt",
    attachmentPromptExpected: true,
    baselineUserMessageCount: 101,
    baselineAssistantMessageCount: 16,
  });

  assert.equal(observation.status, "pending");
  assert.equal(observation.evidence?.composerPromptState, "empty");
  assert.equal(observation.evidence?.composerAttachmentCount, 0);
  assert.equal(fixture.sendSubmissions(), 0);
});

test("submitted attachment observation proves not sent from residual composer evidence", async () => {
  const conversationUrl = "https://chatgpt.com/c/submitted-attachment-residual";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    initialModel: "Pro",
    hydratedComposer: true,
    states: [
      {
        isAnswering: false,
        assistantText: "round 84 response",
        userMessageCount: 101,
        assistantMessageCount: 16,
        lastUserText: "round 84 attachment",
        lastMessageRole: "assistant",
      },
    ],
    composerStates: [
      {
        state: "attachment_ready",
        inlineTextLength: 0,
        attachmentCount: 1,
        sendButtonEnabled: true,
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    timeoutMs: 20,
    pollIntervalMs: 1,
    stableMs: 0,
  });

  const observation = await adapter.observeSubmittedTurn!({
    runId: "run_submitted_attachment_residual",
    round: 85,
    requestId: "msg_submitted_attachment_residual",
    prompt: "round 85 attachment prompt",
    attachmentPromptExpected: true,
    baselineUserMessageCount: 101,
    baselineAssistantMessageCount: 16,
  });

  assert.equal(observation.status, "definitely_not_sent");
  assert.equal(observation.evidence.composerPromptState, "attachment_ready");
  assert.equal(observation.evidence.composerAttachmentCount, 1);
  assert.equal(observation.evidence.composerSendButtonEnabled, true);
  assert.equal(fixture.sendSubmissions(), 0);
});

test("submitted attachment observation treats hydrated history uplift as not sent before stale response parsing", async () => {
  const conversationUrl = "https://chatgpt.com/c/submitted-attachment-hydration-uplift";
  const runId = "run_submitted_attachment_hydration_uplift";
  const requestId = "msg_round_87_hydration_uplift";
  const staleResponse = `<CueLineControl>${JSON.stringify({
    protocol: "cueline/0.1",
    run_id: runId,
    round: 86,
    request_id: "msg_round_86_stale",
    action: "dispatch",
    jobs: [],
  })}</CueLineControl>`;
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    initialModel: "Pro",
    hydratedComposer: true,
    states: [
      {
        isAnswering: false,
        assistantText: staleResponse,
        userMessageCount: 103,
        assistantMessageCount: 102,
        assistantModelSlug: "gpt-5-6-pro",
        lastUserText: "round 86 request",
        lastMessageRole: "assistant",
      },
    ],
    composerStates: [
      {
        state: "attachment_ready",
        inlineTextLength: 0,
        attachmentCount: 1,
        sendButtonEnabled: true,
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    timeoutMs: 20,
    pollIntervalMs: 1,
    stableMs: 0,
  });

  const observation = await adapter.observeSubmittedTurn!({
    runId,
    round: 87,
    requestId,
    prompt: "round 87 attachment prompt",
    attachmentPromptExpected: true,
    baselineUserMessageCount: 0,
    baselineAssistantMessageCount: 0,
  });

  assert.equal(observation.status, "definitely_not_sent");
  assert.equal(observation.evidence.baselineUserMessageCount, 0);
  assert.equal(observation.evidence.observedUserMessageCount, 103);
  assert.equal(fixture.sendSubmissions(), 0);
  assert.deepEqual(fixture.composer.fills, []);
});

test("submitted inline observation treats hydrated history uplift as not sent while the exact prompt stays staged", async () => {
  const conversationUrl = "https://chatgpt.com/c/submitted-inline-hydration-uplift";
  const prompt = "round 87 inline prompt still staged";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    initialModel: "Pro",
    hydratedComposer: true,
    states: [
      {
        isAnswering: false,
        assistantText: "round 86 response",
        userMessageCount: 103,
        assistantMessageCount: 102,
        lastUserText: "round 86 request",
        lastMessageRole: "assistant",
      },
    ],
    composerStates: [
      {
        state: "inline_ready",
        inlineTextLength: prompt.length,
        attachmentCount: 0,
        sendButtonEnabled: true,
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    timeoutMs: 20,
    pollIntervalMs: 1,
    stableMs: 0,
  });

  const observation = await adapter.observeSubmittedTurn!({
    runId: "run_submitted_inline_hydration_uplift",
    round: 87,
    requestId: "msg_submitted_inline_hydration_uplift",
    prompt,
    baselineUserMessageCount: 1,
    baselineAssistantMessageCount: 1,
  });

  assert.equal(observation.status, "definitely_not_sent");
  assert.equal(observation.evidence.observedUserMessageCount, 103);
  assert.equal(fixture.sendSubmissions(), 0);
});

test("submitted attachment observation ignores a stale assistant when no current request is correlated", async () => {
  const conversationUrl = "https://chatgpt.com/c/submitted-attachment-stale-assistant";
  const runId = "run_submitted_attachment_stale_assistant";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    initialModel: "Pro",
    hydratedComposer: true,
    states: [
      {
        isAnswering: false,
        assistantText: `<CueLineControl>${JSON.stringify({
          protocol: "cueline/0.1",
          run_id: runId,
          round: 86,
          request_id: "msg_stale_round_86",
          action: "wait",
        })}</CueLineControl>`,
        userMessageCount: 103,
        assistantMessageCount: 102,
        assistantModelSlug: "gpt-5-6-pro",
        lastUserText: "Pasted text(95).txt\nDocument",
        lastMessageRole: "assistant",
      },
    ],
    composerStates: [
      {
        state: "empty",
        inlineTextLength: 0,
        attachmentCount: 0,
        sendButtonEnabled: false,
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    timeoutMs: 5,
    pollIntervalMs: 1,
    stableMs: 0,
  });

  const observation = await adapter.observeSubmittedTurn!({
    runId,
    round: 87,
    requestId: "msg_current_round_87",
    prompt: "current round 87 attachment prompt",
    attachmentPromptExpected: true,
    baselineUserMessageCount: 0,
    baselineAssistantMessageCount: 0,
  });

  assert.equal(observation.status, "pending");
  assert.equal(fixture.sendSubmissions(), 0);
});

test("submitted observation accepts a hydrated response after the exact current user request is correlated", async () => {
  const conversationUrl = "https://chatgpt.com/c/submitted-current-request-correlated";
  const runId = "run_submitted_current_request_correlated";
  const requestId = "msg_submitted_current_request_correlated";
  const prompt = "exact current round 87 inline prompt";
  const response = `<CueLineControl>${JSON.stringify({
    protocol: "cueline/0.1",
    run_id: runId,
    round: 87,
    request_id: requestId,
    action: "wait",
  })}</CueLineControl>`;
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    initialModel: "Pro",
    hydratedComposer: true,
    states: [
      {
        isAnswering: false,
        assistantText: response,
        userMessageCount: 103,
        assistantMessageCount: 102,
        assistantModelSlug: "gpt-5-6-pro",
        lastUserText: prompt,
        lastMessageRole: "assistant",
      },
    ],
    composerStates: [
      {
        state: "empty",
        inlineTextLength: 0,
        attachmentCount: 0,
        sendButtonEnabled: false,
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    timeoutMs: 20,
    pollIntervalMs: 1,
    stableMs: 0,
  });

  const observation = await adapter.observeSubmittedTurn!({
    runId,
    round: 87,
    requestId,
    prompt,
    baselineUserMessageCount: 1,
    baselineAssistantMessageCount: 1,
  });

  assert.equal(observation.status, "response");
  assert.equal(observation.status === "response" ? observation.turn.text : null, response);
  assert.equal(fixture.sendSubmissions(), 0);
});

test("submitted attachment observation still exposes a malformed current response after reliable user-turn correlation", async () => {
  const conversationUrl = "https://chatgpt.com/c/submitted-attachment-current-malformed";
  const runId = "run_submitted_attachment_current_malformed";
  const malformedResponse = `<CueLineControl>${JSON.stringify({
    protocol: "cueline/0.1",
    run_id: runId,
    round: 87,
    action: "inspect",
    job_ids: ["job_existing"],
  })}</CueLineControl>`;
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    initialModel: "Pro",
    hydratedComposer: true,
    states: [
      {
        isAnswering: false,
        assistantText: malformedResponse,
        userMessageCount: 52,
        assistantMessageCount: 5,
        assistantModelSlug: "gpt-5-6-pro",
        lastUserText: "Pasted text(96).txt\nDocument",
        lastMessageRole: "assistant",
      },
    ],
    composerStates: [
      {
        state: "empty",
        inlineTextLength: 0,
        attachmentCount: 0,
        sendButtonEnabled: false,
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    timeoutMs: 20,
    pollIntervalMs: 1,
    stableMs: 0,
  });

  const observation = await adapter.observeSubmittedTurn!({
    runId,
    round: 87,
    requestId: "msg_current_round_87",
    prompt: "current round 87 attachment prompt",
    attachmentPromptExpected: true,
    baselineUserMessageCount: 51,
    baselineAssistantMessageCount: 4,
  });

  assert.equal(observation.status, "response");
  assert.equal(observation.status === "response" ? observation.turn.text : null, malformedResponse);
  assert.equal(fixture.sendSubmissions(), 0);
});

test("legacy pre-submission observation derives an idle baseline without sending", async () => {
  const conversationUrl = "https://chatgpt.com/c/legacy-pre-submission-observation";
  const prompt = "Round 68 request envelope that was never submitted";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    initialModel: "Pro",
    hydratedComposer: true,
    states: [
      {
        isAnswering: false,
        assistantText: "round 67 response",
        userMessageCount: 67,
        assistantMessageCount: 67,
        lastUserText: "round 67 request",
        lastMessageRole: "assistant",
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    timeoutMs: 20,
    pollIntervalMs: 1,
    stableMs: 0,
  });

  const observation = await adapter.observeSubmittedTurn!({
    runId: "run_legacy_pre_submission_observation",
    round: 68,
    requestId: "msg_legacy_pre_submission_observation",
    prompt,
    legacyPreSubmissionRecovery: true,
  });

  assert.equal(observation.status, "definitely_not_sent");
  assert.equal(observation.status === "definitely_not_sent" && observation.evidence.hydrated, true);
  assert.equal(
    observation.status === "definitely_not_sent" &&
      observation.evidence.baselineUserMessageCount,
    67,
  );
  assert.equal(fixture.sendSubmissions(), 0);
});

test("submitted attachment recovery accepts an exact idle Pro envelope after assistant DOM count regresses", async () => {
  const conversationUrl = "https://chatgpt.com/c/rebooted-attachment-recovery";
  const runId = "run_rebooted_attachment_recovery";
  const requestId = "msg_rebooted_attachment_recovery";
  const response = `<CueLineControl> ${JSON.stringify({
    protocol: "cueline/0.1",
    run_id: runId,
    round: 35,
    request_id: requestId,
    action: "inspect",
    job_ids: ["job_existing"],
  })} </CueLineControl>`;
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    initialModel: "Pro",
    hydratedComposer: true,
    states: [
      {
        isAnswering: false,
        assistantText: response,
        userMessageCount: 52,
        assistantMessageCount: 3,
        assistantModelSlug: "gpt-5-6-pro",
        lastUserText: "Pasted text(96).txt\nDocument",
        lastMessageRole: "assistant",
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    timeoutMs: 20,
    pollIntervalMs: 1,
    stableMs: 0,
  });

  const observation = await adapter.observeSubmittedTurn!({
    runId,
    round: 35,
    requestId,
    prompt: "full prompt is represented by the attachment card after restart",
    attachmentPromptExpected: true,
    baselineUserMessageCount: 51,
    baselineAssistantMessageCount: 4,
  });

  assert.equal(observation.status, "response");
  assert.equal(observation.status === "response" ? observation.turn.text : null, response);
  assert.equal(fixture.sendSubmissions(), 0);
  assert.deepEqual(fixture.composer.fills, []);
});

for (const scenario of [
  { name: "assistant is still answering", isAnswering: true },
  { name: "request identity differs", requestId: "msg_other" },
  { name: "round identity differs", round: 34 },
  { name: "assistant response has no matching envelope", omitEnvelope: true },
] as const) {
  test(`submitted attachment recovery stays pending when ${scenario.name}`, async () => {
    const conversationUrl = `https://chatgpt.com/c/rebooted-attachment-negative-${scenario.name.replaceAll(" ", "-")}`;
    const runId = "run_rebooted_attachment_negative";
    const requestId = "msg_rebooted_attachment_negative";
    const response = scenario.omitEnvelope
      ? "unrelated completed assistant response"
      : `<CueLineControl>${JSON.stringify({
          protocol: "cueline/0.1",
          run_id: runId,
          round: scenario.round ?? 35,
          request_id: scenario.requestId ?? requestId,
          action: "inspect",
          job_ids: ["job_existing"],
        })}</CueLineControl>`;
    const fixture = fakeBrowser({
      initialUrl: conversationUrl,
      initialModel: "Pro",
      hydratedComposer: true,
      states: [
        {
          isAnswering: scenario.isAnswering ?? false,
          assistantText: response,
          userMessageCount: 52,
          assistantMessageCount: 3,
          assistantModelSlug: "gpt-5-6-pro",
          lastUserText: "Pasted text(96).txt\nDocument",
          lastMessageRole: "assistant",
        },
      ],
    });
    const adapter = createCodexIabAdapter({
      browser: fixture.browser,
      conversationUrl,
      timeoutMs: 20,
      pollIntervalMs: 1,
      stableMs: 0,
    });

    const observation = await adapter.observeSubmittedTurn!({
      runId,
      round: 35,
      requestId,
      prompt: "full prompt is represented by the attachment card after restart",
      attachmentPromptExpected: true,
      baselineUserMessageCount: 51,
      baselineAssistantMessageCount: 4,
    });

    assert.equal(observation.status, "pending");
    assert.equal(fixture.sendSubmissions(), 0);
  });
}

test("submitted attachment recovery rejects an exact envelope from a non-Pro response", async () => {
  const conversationUrl = "https://chatgpt.com/c/rebooted-attachment-non-pro";
  const runId = "run_rebooted_attachment_non_pro";
  const requestId = "msg_rebooted_attachment_non_pro";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    initialModel: "Pro",
    hydratedComposer: true,
    states: [
      {
        isAnswering: false,
        assistantText: `<CueLineControl>${JSON.stringify({
          protocol: "cueline/0.1",
          run_id: runId,
          round: 35,
          request_id: requestId,
          action: "inspect",
          job_ids: ["job_existing"],
        })}</CueLineControl>`,
        userMessageCount: 52,
        assistantMessageCount: 3,
        assistantModelSlug: "gpt-5-6-thinking",
        lastUserText: "Pasted text(96).txt\nDocument",
        lastMessageRole: "assistant",
      },
    ],
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    conversationUrl,
    timeoutMs: 20,
    pollIntervalMs: 1,
    stableMs: 0,
  });

  await assert.rejects(
    adapter.observeSubmittedTurn!({
      runId,
      round: 35,
      requestId,
      prompt: "full prompt is represented by the attachment card after restart",
      attachmentPromptExpected: true,
      baselineUserMessageCount: 51,
      baselineAssistantMessageCount: 4,
    }),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "PRO_MODEL_MISMATCH",
  );
  assert.equal(fixture.sendSubmissions(), 0);
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

test("reuses CueLine's own leftover attachment on an operator-confirmed not-sent retry without re-filling", async () => {
  const conversationUrl = "https://chatgpt.com/c/reuse-not-sent-attachment";
  const abandonedRequestId = "msg_abandoned";
  const requestId = "msg_retry";
  const prompt = `Controller envelope requestId=${requestId} :: ${"x".repeat(44_679)}`;
  const abandonedPrompt = prompt.split(requestId).join(abandonedRequestId);
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    initialModel: "Pro",
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
        attachmentCount: 1,
        sendButtonEnabled: true,
      },
    ],
    states: [
      {
        isAnswering: false,
        assistantText: "",
        assistantMessageCount: 0,
        userMessageCount: 1,
        lastUserText: "controller-observation.txt",
        lastMessageRole: "assistant",
      },
      {
        isAnswering: true,
        assistantText: "working",
        assistantMessageCount: 0,
        userMessageCount: 2,
      },
      {
        isAnswering: false,
        assistantText: "reused attachment response",
        assistantMessageCount: 1,
        userMessageCount: 2,
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

  const turn = await adapter.sendTurn({
    runId: "run_reuse_not_sent_attachment",
    round: 2,
    requestId,
    prompt,
    attachmentPromptExpected: true,
    notSentRecovery: {
      abandonedRequestId,
      promptHash: commandHash(abandonedPrompt),
      conversationUrl,
      baselineUserMessageCount: 1,
    },
  } as BrowserTurnInput);

  assert.equal(turn.text, "reused attachment response");
  assert.equal(fixture.sendButtons[0]?.clicks, 1);
  assert.equal(fixture.sendSubmissions(), 1);
  assert.deepEqual(fixture.composer.fills, []);
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

test("treats the new user message as the confirmed retry during manual recovery", async () => {
  const conversationUrl = "https://chatgpt.com/c/manual-confirmed-retry";
  const response = `<CueLineControl>${JSON.stringify({
    protocol: "cueline/0.1",
    run_id: "run_manual_confirmed_retry",
    round: 2,
    request_id: "msg_retry",
    action: "complete",
    final_delivery_text: "RETRY_CONFIRMED",
  })}</CueLineControl>`;
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    initialModel: "Pro",
    states: [
      {
        isAnswering: false,
        assistantText: response,
        assistantMessageCount: 2,
        userMessageCount: 3,
        lastUserText: "Pasted text(35).txt",
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
    runId: "run_manual_confirmed_retry",
    round: 2,
    requestId: "msg_retry",
    prompt: "retry prompt",
    manualSendConfirmed: true,
    notSentRecovery: {
      abandonedRequestId: "msg_original",
      promptHash: commandHash("original prompt"),
      conversationUrl,
      baselineUserMessageCount: 1,
    },
  });

  assert.equal(turn.text, response);
  assert.equal(fixture.sendSubmissions(), 0);
});

test("accepts an exact manually confirmed envelope when the assistant count already reached baseline", async () => {
  const conversationUrl = "https://chatgpt.com/c/manual-fast-response";
  const response = `<CueLineControl>${JSON.stringify({
    protocol: "cueline/0.1",
    run_id: "run_manual_fast_response",
    round: 3,
    request_id: "msg_fast_response",
    action: "inspect",
    job_ids: ["job_evidence"],
  })}</CueLineControl>`;
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    initialModel: "Pro",
    states: [
      {
        isAnswering: false,
        assistantText: response,
        assistantMessageCount: 3,
        userMessageCount: 3,
        lastUserText: "Pasted text(36).txt",
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
    runId: "run_manual_fast_response",
    round: 3,
    requestId: "msg_fast_response",
    prompt: "inspect evidence window",
    manualSendConfirmed: true,
    baselineAssistantMessageCount: 3,
  });

  assert.equal(turn.text, response);
  assert.equal(fixture.sendSubmissions(), 0);
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

test("a stalled pre-click browser read fails early as definitely not sent", async () => {
  const prompt = "Attachment-backed round must fail before click";
  const fixture = fakeBrowser({
    states: [
      {
        isAnswering: false,
        assistantText: "prior response",
        userMessageCount: 84,
        assistantMessageCount: 16,
        lastUserText: "round 84",
        lastMessageRole: "assistant",
      },
    ],
    hydratedComposer: true,
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
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 20,
  });
  const checkpoints: string[] = [];
  let guardTimer: NodeJS.Timeout | undefined;
  const guardedSubmission = Promise.race([
    adapter.submitTurn!(
      {
        runId: "run_preclick_stall",
        round: 85,
        requestId: "msg_preclick_stall",
        prompt,
      },
      {
        async onCheckpoint(checkpoint) {
          checkpoints.push(checkpoint.submissionState);
          if (checkpoint.submissionState === "submitting") {
            fixture.hangFutureUrlReads();
          }
        },
      },
    ),
    new Promise<never>((_resolve, reject) => {
      guardTimer = setTimeout(
        () => reject(new Error("TEST_OUTER_TIMEOUT_BEFORE_INNER_TIMEOUT")),
        200,
      );
    }),
  ]);

  try {
    await assert.rejects(
      guardedSubmission,
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "CONTROLLER_SUBMISSION_PRECLICK_TIMEOUT" &&
        "details" in error &&
        typeof error.details === "object" &&
        error.details !== null &&
        (error.details as Record<string, unknown>).submission_state ===
          "definitely_not_sent",
    );
  } finally {
    clearTimeout(guardTimer);
  }

  assert.deepEqual(checkpoints, ["submitting"]);
  assert.equal(fixture.sendButtons[0]?.clicks, 0);
  assert.equal(fixture.sendSubmissions(), 0);
});

test("a stalled send click fails early as ambiguous without a second click", async () => {
  const fixture = fakeBrowser({
    states: [
      { isAnswering: false, assistantText: "", assistantMessageCount: 0 },
      { isAnswering: false, assistantText: "", assistantMessageCount: 0 },
    ],
    hangSendClick: true,
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 20,
  });
  const checkpoints: string[] = [];
  let guardTimer: NodeJS.Timeout | undefined;
  const guardedSubmission = Promise.race([
    adapter.submitTurn!(
      {
        runId: "run_click_stall",
        round: 1,
        requestId: "msg_click_stall",
        prompt: "Never retry an uncertain click",
      },
      {
        async onCheckpoint(checkpoint) {
          checkpoints.push(checkpoint.submissionState);
        },
      },
    ),
    new Promise<never>((_resolve, reject) => {
      guardTimer = setTimeout(
        () => reject(new Error("TEST_OUTER_TIMEOUT_BEFORE_INNER_TIMEOUT")),
        200,
      );
    }),
  ]);

  try {
    await assert.rejects(
      guardedSubmission,
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "CONTROLLER_SUBMISSION_AMBIGUOUS" &&
        "details" in error &&
        typeof error.details === "object" &&
        error.details !== null &&
        (error.details as Record<string, unknown>).submission_state ===
          "possibly_sent",
    );
  } finally {
    clearTimeout(guardTimer);
  }

  assert.deepEqual(checkpoints, ["submitting", "possibly_sent"]);
  assert.equal(fixture.sendButtons[0]?.clicks, 1);
  assert.equal(fixture.sendButtons[1]?.clicks, 0);
  assert.equal(fixture.sendSubmissions(), 0);
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
    stableMs: 1,
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

test("tab discovery refuses multiple matching session tabs instead of choosing the first", async () => {
  const fixture = fakeBrowser({
    states: [{ isAnswering: false, assistantText: "", assistantMessageCount: 0 }],
  });
  let getCalls = 0;
  let newCalls = 0;
  const browser: IabBrowser = {
    tabs: {
      async selected() {
        return undefined;
      },
      async list() {
        return [
          { id: "chat-one", url: "https://chatgpt.com/c/chat-one" },
          { id: "chat-two", url: "https://chatgpt.com/c/chat-two" },
        ];
      },
      async get() {
        getCalls += 1;
        return fixture.tab;
      },
      async new() {
        newCalls += 1;
        return fixture.tab;
      },
    },
  };

  await assert.rejects(
    acquireChatGptTab(browser),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "IAB_CHATGPT_TAB_AMBIGUOUS",
  );
  assert.equal(getCalls, 0);
  assert.equal(newCalls, 0);
});

test("tab discovery refuses multiple claimable copies of one exact conversation", async () => {
  const conversationUrl = "https://chatgpt.com/c/exact-duplicate";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    states: [{ isAnswering: false, assistantText: "", assistantMessageCount: 0 }],
  });
  let claimCalls = 0;
  let newCalls = 0;
  const browser: IabBrowser = {
    tabs: {
      async selected() {
        return undefined;
      },
      async list() {
        return [];
      },
      async new() {
        newCalls += 1;
        return fixture.tab;
      },
    },
    user: {
      async openTabs() {
        return [
          { id: "copy-one", url: conversationUrl },
          { id: "copy-two", url: conversationUrl },
        ];
      },
      async claimTab() {
        claimCalls += 1;
        return fixture.tab;
      },
    },
  };

  await assert.rejects(
    acquireChatGptTab(browser, conversationUrl),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "IAB_CHATGPT_TAB_AMBIGUOUS",
  );
  assert.equal(claimCalls, 0);
  assert.equal(newCalls, 0);
});

test("tab discovery deduplicates repeated listings of one physical tab", async () => {
  const conversationUrl = "https://chatgpt.com/c/repeated-listing";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    states: [{ isAnswering: false, assistantText: "", assistantMessageCount: 0 }],
  });
  let getCalls = 0;
  const browser: IabBrowser = {
    tabs: {
      async selected() {
        return undefined;
      },
      async list() {
        return [
          { id: "same-tab", url: conversationUrl },
          { id: "same-tab", url: conversationUrl },
        ];
      },
      async get() {
        getCalls += 1;
        return fixture.tab;
      },
      async new() {
        throw new Error("UNEXPECTED_NEW_TAB");
      },
    },
  };

  const tab = await acquireChatGptTab(browser, conversationUrl);
  assert.equal(tab, fixture.tab);
  assert.equal(getCalls, 1);
});

test("tab discovery reopens the exact conversation when the controlled tab list is empty", async () => {
  const conversationUrl = "https://chatgpt.com/c/reopen-exact-conversation";
  const fixture = fakeBrowser({
    initialUrl: "https://chatgpt.com/",
    states: [{ isAnswering: false, assistantText: "", assistantMessageCount: 0 }],
  });
  let newCalls = 0;
  const browser: IabBrowser = {
    tabs: {
      async selected() {
        return undefined;
      },
      async list() {
        return [];
      },
      async new() {
        newCalls += 1;
        return fixture.tab;
      },
    },
  };

  const tab = await acquireChatGptTab(browser, conversationUrl);

  assert.equal(newCalls, 1);
  assert.equal(await tab.url(), conversationUrl);
});

test("tab discovery filters the exact target before deduplicating stale tab listings", async () => {
  const conversationUrl = "https://chatgpt.com/c/current-target";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    states: [{ isAnswering: false, assistantText: "", assistantMessageCount: 0 }],
  });
  let getCalls = 0;
  const browser: IabBrowser = {
    tabs: {
      async selected() {
        return undefined;
      },
      async list() {
        return [
          { id: "reused-tab", url: "https://chatgpt.com/c/stale-target" },
          { id: "reused-tab", url: conversationUrl },
        ];
      },
      async get() {
        getCalls += 1;
        return fixture.tab;
      },
      async new() {
        throw new Error("UNEXPECTED_NEW_TAB");
      },
    },
  };

  const tab = await acquireChatGptTab(browser, conversationUrl);
  assert.equal(tab, fixture.tab);
  assert.equal(getCalls, 1);
});

test("tab discovery reports ambiguity even when selected-tab attachment is unavailable", async () => {
  const fixture = fakeBrowser({
    states: [{ isAnswering: false, assistantText: "", assistantMessageCount: 0 }],
  });
  let selectedCalls = 0;
  let newCalls = 0;
  const browser: IabBrowser = {
    tabs: {
      async selected() {
        selectedCalls += 1;
        throw new Error("Browser webview attach timeout");
      },
      async list() {
        return [
          { id: "chat-one", url: "https://chatgpt.com/c/chat-one" },
          { id: "chat-two", url: "https://chatgpt.com/c/chat-two" },
        ];
      },
      async get() {
        return fixture.tab;
      },
      async new() {
        newCalls += 1;
        return fixture.tab;
      },
    },
  };

  await assert.rejects(
    acquireChatGptTab(browser),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "IAB_CHATGPT_TAB_AMBIGUOUS",
  );
  assert.equal(selectedCalls, 2);
  assert.equal(newCalls, 0);
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

for (const scenario of [
  { name: "stale", lastUserText: "older virtualized user message" },
  { name: "null", lastUserText: null },
] as const) {
  test(`recovery accepts an exact accessibility envelope when lastUserText is ${scenario.name}`, async () => {
    const conversationUrl = `https://chatgpt.com/c/exact-envelope-${scenario.name}-user`;
    const runId = `run_exact_envelope_${scenario.name}_user`;
    const requestId = `msg_exact_envelope_${scenario.name}_user`;
    const response = `<CueLineControl>${JSON.stringify({
      protocol: "cueline/0.1",
      run_id: runId,
      round: 94,
      request_id: requestId,
      action: "wait",
    })}</CueLineControl>`;
    const fixture = fakeBrowser({
      initialUrl: conversationUrl,
      initialModel: "Pro",
      states: [
        {
          isAnswering: false,
          assistantText: "",
          userMessageCount: 0,
          assistantMessageCount: 0,
          assistantModelSlug: "gpt-5-6-pro",
          lastUserText: scenario.lastUserText,
          lastMessageRole: null,
        },
      ],
      accessibilitySnapshots: [
        `- main:\n  - article:\n    - heading "ChatGPT said:"\n    - paragraph: ${JSON.stringify(response)}`,
      ],
    });
    const adapter = createCodexIabAdapter({
      browser: fixture.browser,
      conversationUrl,
      pollIntervalMs: 1,
      stableMs: 0,
      timeoutMs: 20,
    });

    const turn = await adapter.recoverTurn!({
      runId,
      round: 94,
      requestId,
      prompt: "current round 94 prompt hidden by virtualization",
    });

    assert.equal(turn.text, response);
    assert.equal(turn.conversationUrl, conversationUrl);
    assert.equal(
      (turn as ControllerTurn & {
        responseSource?: "count_degraded_accessibility_exact_envelope";
      }).responseSource,
      "count_degraded_accessibility_exact_envelope",
    );
    assert.equal(fixture.accessibilitySnapshotReads(), 1);
    assert.equal(fixture.sendSubmissions(), 0);
    assert.deepEqual(fixture.composer.fills, []);
  });
}

test("recovery treats contenteditable block newlines as the same user prompt", async () => {
  const conversationUrl = "https://chatgpt.com/c/recovery-block-newlines";
  const prompt = "First instruction\nSecond instruction\nThird instruction";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    initialModel: "Pro",
    states: [
      {
        isAnswering: false,
        assistantText: "completed multiline response",
        assistantMessageCount: 1,
        lastUserText: "First instruction\n\nSecond instruction\r\n \nThird instruction",
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
    runId: "run_recovery_block_newlines",
    round: 1,
    requestId: "msg_recovery_block_newlines",
    prompt,
  });

  assert.equal(turn.text, "completed multiline response");
  assert.equal(turn.conversationUrl, conversationUrl);
  assert.deepEqual(fixture.composer.fills, []);
  assert.equal(fixture.sendButtons[0]!.clicks, 0);
});

test("recovery newline normalization preserves meaningful indentation", async () => {
  const conversationUrl = "https://chatgpt.com/c/recovery-indentation";
  const fixture = fakeBrowser({
    initialUrl: conversationUrl,
    initialModel: "Pro",
    states: [
      {
        isAnswering: false,
        assistantText: "reply to a differently indented prompt",
        assistantMessageCount: 1,
        lastUserText: "Run exactly:\nnpm test",
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
      runId: "run_recovery_indentation",
      round: 1,
      requestId: "msg_recovery_indentation",
      prompt: "Run exactly:\n  npm test",
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CONTROLLER_RECONCILIATION_MISMATCH",
  );
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
      (error.details as { submission_state?: unknown }).submission_state ===
        "possibly_sent",
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
