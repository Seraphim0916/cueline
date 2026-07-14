import assert from "node:assert/strict";
import test from "node:test";

import { createCodexIabAdapter } from "../../src/browser/codex-iab/chatgpt-client.js";
import type {
  IabBrowser,
  IabLocator,
  IabTab,
  PageChatState,
} from "../../src/browser/codex-iab/bootstrap.js";

class FakeLocator implements IabLocator {
  readonly fills: string[] = [];
  readonly waits: Array<{ state: string; timeoutMs?: number }> = [];
  clicks = 0;
  countResult = 1;
  failFirstClick = false;
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
      throw new Error(this.firstClickError);
    }
    this.onClick?.();
  }
}

function fakeBrowser(options: {
  states: Array<
    Omit<PageChatState, "assistantModelSlug" | "lastUserText" | "lastMessageRole"> & {
      assistantModelSlug?: string | null;
      lastUserText?: string | null;
      lastMessageRole?: "assistant" | "user" | null;
    }
  >;
  initialUrl?: string;
  submittedUrl?: string;
  failFirstClick?: boolean;
  firstClickError?: string;
  failStateReadAt?: number;
  stateReadError?: string;
  hydratedComposer?: boolean;
  missingSendButtonAfterRetry?: boolean;
  initialModel?: string | null;
  proOptionAvailable?: boolean;
  proSelectionSucceeds?: boolean;
  responseModelSlug?: string | null;
}) {
  const composer = new FakeLocator();
  const hydratedComposer = new FakeLocator();
  const missingHydratedComposer = new FakeLocator();
  missingHydratedComposer.countResult = 0;
  const sendButtons = [new FakeLocator(), new FakeLocator()];
  const missingSendButton = new FakeLocator();
  missingSendButton.countResult = 0;
  let modelLabel = options.initialModel === undefined ? "Pro" : options.initialModel;
  const modelPicker = new FakeLocator();
  const proOption = new FakeLocator(() => {
    if (options.proSelectionSucceeds !== false) modelLabel = "Pro";
  });
  const missingProOption = new FakeLocator();
  missingProOption.countResult = 0;
  sendButtons[0]!.failFirstClick = options.failFirstClick ?? false;
  sendButtons[0]!.firstClickError = options.firstClickError ?? sendButtons[0]!.firstClickError;
  const requestedRoles: Array<{ role: string; name: string }> = [];
  const requestedSelectors: string[] = [];
  let stateIndex = 0;
  let stateRead = 0;
  let url = options.initialUrl ?? "https://chatgpt.com/";
  let snapshots = 0;
  let sendLookup = 0;

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
      if (options.missingSendButtonAfterRetry && snapshots > 0) {
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
        "modelPickerSelector" in argument
      ) {
        return modelLabel as Result;
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
      snapshots += 1;
      return {};
    },
    async waitForTimeout() {},
  };

  const tab: IabTab = {
    async goto(nextUrl) {
      url = nextUrl;
    },
    async url() {
      return url;
    },
    playwright,
  };
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
    snapshots: () => snapshots,
  };
}

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

test("reacquires a replaced send button once after a transient click failure", async () => {
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

  const turn = await adapter.sendTurn({
    runId: "run_1",
    round: 1,
    requestId: "msg_1",
    prompt: "Retry safely",
  });

  assert.equal(fixture.sendButtons[0]?.clicks, 1);
  assert.equal(fixture.sendButtons[1]?.clicks, 1);
  assert.equal(fixture.snapshots(), 1);
  assert.equal(turn.text, "complete");
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

test("accepts submission when the send button disappears after a transient state read failure", async () => {
  const fixture = fakeBrowser({
    states: [
      { isAnswering: false, assistantText: "", assistantMessageCount: 0 },
      { isAnswering: true, assistantText: "started", assistantMessageCount: 0 },
      { isAnswering: false, assistantText: "finished", assistantMessageCount: 1 },
    ],
    failFirstClick: true,
    failStateReadAt: 1,
    missingSendButtonAfterRetry: true,
  });
  const adapter = createCodexIabAdapter({
    browser: fixture.browser,
    pollIntervalMs: 1,
    stableMs: 0,
    timeoutMs: 1_000,
  });

  const turn = await adapter.sendTurn({
    runId: "run_transient",
    round: 1,
    requestId: "msg_transient",
    prompt: "Recover without duplicate send",
  });

  assert.equal(fixture.sendButtons[0]?.clicks, 1);
  assert.equal(fixture.sendButtons[1]?.clicks, 0);
  assert.equal(fixture.snapshots(), 1);
  assert.equal(turn.text, "finished");
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
    responseModelSlug: "gpt-5-6-thinking",
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
