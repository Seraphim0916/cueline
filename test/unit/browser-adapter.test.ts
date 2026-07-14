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
  clicks = 0;
  failFirstClick = false;

  async count(): Promise<number> {
    return 1;
  }

  async fill(value: string): Promise<void> {
    this.fills.push(value);
  }

  async click(): Promise<void> {
    this.clicks += 1;
    if (this.failFirstClick && this.clicks === 1) {
      throw new Error("Playwright timeout: detached button");
    }
  }
}

function fakeBrowser(options: {
  states: PageChatState[];
  initialUrl?: string;
  submittedUrl?: string;
  failFirstClick?: boolean;
}) {
  const composer = new FakeLocator();
  const sendButtons = [new FakeLocator(), new FakeLocator()];
  sendButtons[0]!.failFirstClick = options.failFirstClick ?? false;
  const requestedRoles: Array<{ role: string; name: string }> = [];
  let stateIndex = 0;
  let url = options.initialUrl ?? "https://chatgpt.com/";
  let snapshots = 0;
  let sendLookup = 0;

  const tab: IabTab = {
    async goto(nextUrl) {
      url = nextUrl;
    },
    async url() {
      return url;
    },
    playwright: {
      getByRole(role, query) {
        requestedRoles.push({ role, name: query.name });
        if (role === "textbox") return composer;
        const locator = sendButtons[Math.min(sendLookup, sendButtons.length - 1)]!;
        sendLookup += 1;
        return locator;
      },
      async evaluate<Result>() {
        const state = options.states[Math.min(stateIndex, options.states.length - 1)]!;
        stateIndex += 1;
        if (!state.isAnswering && options.submittedUrl) {
          url = options.submittedUrl;
        }
        return state as Result;
      },
      async domSnapshot() {
        snapshots += 1;
        return {};
      },
      async waitForTimeout() {},
    },
  };
  const browser: IabBrowser = {
    async documentation() {},
    tabs: { async new() { return tab; } },
  };
  return { browser, composer, sendButtons, requestedRoles, snapshots: () => snapshots };
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
