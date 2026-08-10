import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { readPageProbeState } from "../../src/browser/codex-iab/bootstrap.js";
import type {
  ClaudeAgentBrowserTools,
  ClaudeAgentReadPageOptions,
  ClaudeAgentTabInfo,
} from "../../src/browser/claude-desktop/agent-tools.js";
import { createClaudeDesktopIabBrowser } from "../../src/browser/claude-desktop/iab-shim.js";
import { CueLineError } from "../../src/core/errors.js";

const TAB: ClaudeAgentTabInfo = {
  tabId: "tab-1",
  url: "https://chatgpt.com/c/run-1",
  title: "Run 1",
};

const INTERACTIVE_TREE = `textbox "Chat with ChatGPT" [ref_6]
button "Send prompt" [ref_7] type="submit"
button "Start dictation" [ref_8] type="button"`;

const FULL_TREE = `main
  article "assistant reply carrying request-42"
${INTERACTIVE_TREE}`;

interface FakeOptions {
  tabs?: ClaudeAgentTabInfo[];
  active?: ClaudeAgentTabInfo;
  interactiveTree?: string;
  fullTree?: string;
  evaluateResult?: unknown;
}

function fakeTools(options: FakeOptions = {}) {
  const calls: string[] = [];
  const sources: string[] = [];
  const tools: ClaudeAgentBrowserTools = {
    async listTabs() {
      return options.tabs ?? [TAB];
    },
    async activeTab() {
      return options.active;
    },
    async newTab(url) {
      calls.push(`newTab:${url ?? ""}`);
      return { ...TAB, ...(url === undefined ? {} : { url }) };
    },
    async navigate(tabId, url) {
      calls.push(`navigate:${tabId}:${url}`);
    },
    async tabUrl() {
      return TAB.url;
    },
    async evaluate(tabId, source) {
      sources.push(source);
      calls.push(`evaluate:${tabId}`);
      return options.evaluateResult;
    },
    async readPage(tabId, readOptions?: ClaudeAgentReadPageOptions) {
      const interactiveOnly = readOptions?.interactiveOnly === true;
      calls.push(`readPage:${tabId}:${interactiveOnly ? "interactive" : "full"}`);
      return interactiveOnly
        ? (options.interactiveTree ?? INTERACTIVE_TREE)
        : (options.fullTree ?? FULL_TREE);
    },
    async clickRef(tabId, ref) {
      calls.push(`clickRef:${ref}`);
    },
  };
  return { tools, calls, sources };
}

async function selectedTab(options: FakeOptions = {}) {
  const fake = fakeTools({ active: TAB, ...options });
  const browser = createClaudeDesktopIabBrowser({ tools: fake.tools, sleep: async () => {} });
  const tab = await browser.tabs.selected?.();
  assert.ok(tab, "expected a selected tab");
  return { ...fake, tab };
}

test("evaluate transports the page function as a self-contained expression", async () => {
  const { tab, sources } = await selectedTab({ evaluateResult: { ok: true } });
  await tab.playwright.evaluate(({ probe }: { probe: string }) => probe, { probe: "diagnostic" });

  assert.equal(sources.length, 1);
  const source = sources[0]!;
  assert.ok(source.startsWith("("), "source must be a parenthesised call expression");
  assert.ok(source.includes("probe"), "the page function body must be carried verbatim");
  assert.ok(
    source.includes('({"probe":"diagnostic"})'),
    "argument must be serialised into the call",
  );
});

test("transported source runs in a bare page context", async () => {
  // The page has none of this process's module scope. esbuild's keep-names
  // transform rewrites page functions to reference its own `__name` helper, so
  // source that is merely stringified throws ReferenceError once it lands.
  const { tab, sources } = await selectedTab({ evaluateResult: {} });
  await tab.playwright.evaluate(({ n }: { n: number }) => ({ doubled: n * 2 }), { n: 21 });
  assert.deepEqual({ ...(runInNewContext(sources[0]!, {}) as object) }, { doubled: 42 });
});

test("a pasted prompt selects and replaces the unique composer when focus falls back to main", async () => {
  const { tab, sources } = await selectedTab();
  await tab.playwright
    .getByRole("textbox", { name: "Chat with ChatGPT" })
    .fill("<CueLineControl>request-42</CueLineControl>");

  const delivered: { type: string; text: string }[] = [];
  let focusCount = 0;
  let selectedTarget: unknown;
  let clearedRanges = 0;
  let installedRanges = 0;
  const range = {
    selectNodeContents(target: unknown) {
      selectedTarget = target;
    },
  };
  const composer = {
    tagName: "DIV",
    isContentEditable: true,
    focus() {
      focusCount += 1;
    },
    dispatchEvent: (event: { type: string; clipboardData: { getData(): string } }) => {
      delivered.push({ type: event.type, text: event.clipboardData.getData() });
      return false;
    },
  };
  const context: Record<string, unknown> = {
    document: {
      activeElement: {
        tagName: "MAIN",
        isContentEditable: false,
      },
      querySelectorAll(selector: string) {
        assert.equal(selector, '[contenteditable="true"]');
        return [composer];
      },
      createRange() {
        return range;
      },
    },
    window: {
      getSelection() {
        return {
          removeAllRanges() {
            clearedRanges += 1;
          },
          addRange(received: unknown) {
            assert.equal(received, range);
            installedRanges += 1;
          },
        };
      },
    },
    DataTransfer: class {
      value = "";
      setData(_type: string, value: string): void {
        this.value = value;
      }
      getData(): string {
        return this.value;
      }
    },
    ClipboardEvent: class {
      type: string;
      clipboardData: { getData(): string };
      constructor(type: string, init: { clipboardData: { getData(): string } }) {
        this.type = type;
        this.clipboardData = init.clipboardData;
      }
    },
  };

  // The result is built inside the VM realm, so compare it structurally.
  assert.deepEqual({ ...(runInNewContext(sources[0]!, context) as object) }, {
    ok: true,
    defaultPrevented: true,
    length: "<CueLineControl>request-42</CueLineControl>".length,
  });
  assert.deepEqual(delivered, [
    { type: "paste", text: "<CueLineControl>request-42</CueLineControl>" },
  ]);
  assert.equal(focusCount, 1);
  assert.equal(selectedTarget, composer);
  assert.equal(clearedRanges, 1);
  assert.equal(installedRanges, 1);
});

test("evaluate substitutes an empty argument object when none is given", async () => {
  const { tab, sources } = await selectedTab({ evaluateResult: {} });
  await tab.playwright.evaluate(() => 1);
  assert.ok(sources[0]!.includes("({})"), `unexpected source: ${sources[0]}`);
});

test("evaluate decodes a JSON payload handed back as text", async () => {
  const { tab } = await selectedTab({
    evaluateResult: {
      protocol: "cueline.evaluate-result/1",
      encoding: "json",
      value: '{"isAnswering":true}',
    },
  });
  assert.deepEqual(await tab.playwright.evaluate(() => ({ isAnswering: false })), {
    isAnswering: true,
  });
});

test("evaluate preserves a JSON-looking literal string through its tagged envelope", async () => {
  const { tab } = await selectedTab({
    evaluateResult: {
      protocol: "cueline.evaluate-result/1",
      encoding: "literal",
      value: '{"isAnswering":true}',
    },
  });
  assert.equal(
    await tab.playwright.evaluate(() => ""),
    '{"isAnswering":true}',
  );
});

test("evaluate leaves a genuine string result untouched", async () => {
  const { tab } = await selectedTab({ evaluateResult: "Stopped thinking" });
  assert.equal(await tab.playwright.evaluate(() => ""), "Stopped thinking");
});

test("the shim carries codex-iab page readers unchanged", async () => {
  const probeState = {
    pageUrl: "https://chatgpt.com/c/run-1",
    isAnswering: false,
    assistantMessageCount: 3,
    lastMessageRole: "assistant",
    assistantModelSlug: "gpt-5-6-pro",
    selectedModelLabel: "Pro",
    modelLabelCount: 1,
    composerState: "empty",
    inlineTextLength: 0,
    attachmentCount: 0,
    sendButtonState: "disabled",
  };
  const { tab } = await selectedTab({
    evaluateResult: {
      protocol: "cueline.evaluate-result/1",
      encoding: "json",
      value: JSON.stringify(probeState),
    },
  });
  assert.deepEqual(await readPageProbeState(tab), probeState);
});

test("a role locator resolves a handle and acts on it", async () => {
  const { tab, calls } = await selectedTab();
  const composer = tab.playwright.getByRole("textbox", { name: "Chat with ChatGPT" });
  assert.equal(await composer.count(), 1);
  await composer.fill("dispatch job-1");
  await tab.playwright.getByRole("button", { name: "Send prompt" }).click();

  assert.ok(calls.includes("clickRef:ref_6"));
  assert.ok(calls.includes("clickRef:ref_7"));
});

test("filling the composer focuses it, then delivers a paste event", async () => {
  const { tab, calls, sources } = await selectedTab();
  await tab.playwright
    .getByRole("textbox", { name: "Chat with ChatGPT" })
    .fill("<CueLineControl>request-42</CueLineControl>");

  assert.equal(
    calls.indexOf("clickRef:ref_6") < calls.indexOf("evaluate:tab-1"),
    true,
    "the composer must be focused before the paste is dispatched",
  );
  const source = sources[0]!;
  assert.ok(source.includes("ClipboardEvent"), "a fill must be delivered as a paste event");
  assert.ok(source.includes("DataTransfer"), "the paste must carry clipboard data");
  assert.ok(
    source.includes('{"text":"<CueLineControl>request-42<\\/CueLineControl>"}') ||
      source.includes('{"text":"<CueLineControl>request-42</CueLineControl>"}'),
    `prompt must be serialised into the paste payload: ${source.slice(-120)}`,
  );
});

test("element resolution reads the interactive tree, never the full one", async () => {
  const { tab, calls } = await selectedTab();
  await tab.playwright.getByRole("button", { name: "Send prompt" }).click();
  assert.ok(calls.includes("readPage:tab-1:interactive"));
  assert.ok(!calls.includes("readPage:tab-1:full"));
});

test("domSnapshot returns the full tree so recovery readers can search message text", async () => {
  const { tab, calls } = await selectedTab();
  const snapshot = await tab.playwright.domSnapshot();
  assert.equal(typeof snapshot, "string");
  assert.ok((snapshot as string).includes("request-42"));
  assert.ok(calls.includes("readPage:tab-1:full"));
});

test("a locator refuses to act when nothing matches", async () => {
  const { tab, calls } = await selectedTab({ interactiveTree: `button "Start Voice" [ref_9]` });
  await assert.rejects(
    () => tab.playwright.getByRole("button", { name: "Send prompt" }).click(),
    (error: unknown) => error instanceof CueLineError && error.code === "IAB_ELEMENT_NOT_FOUND",
  );
  assert.ok(!calls.some((call) => call.startsWith("clickRef:")));
});

test("a match without a host handle fails loudly instead of clicking blind", async () => {
  const { tab, calls } = await selectedTab({ interactiveTree: `button "Send prompt"` });
  await assert.rejects(
    () => tab.playwright.getByRole("button", { name: "Send prompt" }).click(),
    (error: unknown) => error instanceof CueLineError && error.code === "IAB_ELEMENT_REF_MISSING",
  );
  assert.ok(!calls.some((call) => call.startsWith("clickRef:")));
});

test("a disabled send button is reported as disabled", async () => {
  const { tab } = await selectedTab({
    interactiveTree: `button "Send prompt" [ref_7] type="submit" disabled`,
  });
  assert.equal(
    await tab.playwright.getByRole("button", { name: "Send prompt" }).isEnabled?.(),
    false,
  );
});

test("CSS-selector resolution is absent so guarded callers degrade", async () => {
  const { tab } = await selectedTab();
  assert.equal(tab.playwright.locator, undefined);
});

test("no selected tab is reported as absent rather than invented", async () => {
  const { tools } = fakeTools();
  const browser = createClaudeDesktopIabBrowser({ tools });
  assert.equal(await browser.tabs.selected?.(), undefined);
});

test("opening the Claude browser surface supplies preview_start a concrete ChatGPT URL", async () => {
  const { tools, calls } = fakeTools();
  const browser = createClaudeDesktopIabBrowser({ tools, sleep: async () => {} });

  await browser.tabs.new();

  assert.ok(calls.includes("newTab:https://chatgpt.com/"));
});

test("a host answering null for the active tab is treated as absent", async () => {
  // JSON cannot carry undefined, so a real host always sends null here.
  const { tools } = fakeTools();
  const browser = createClaudeDesktopIabBrowser({
    tools: { ...tools, activeTab: async () => null as never },
  });
  assert.equal(await browser.tabs.selected?.(), undefined);
});

test("a host answering null for a tab URL is treated as absent", async () => {
  const { tools } = fakeTools({ active: TAB });
  const browser = createClaudeDesktopIabBrowser({
    tools: { ...tools, tabUrl: async () => null as never },
  });
  const tab = await browser.tabs.selected?.();
  assert.equal(await tab!.url(), undefined);
});

test("a closed tab is refused by id lookup", async () => {
  const { tools } = fakeTools({ tabs: [] });
  const browser = createClaudeDesktopIabBrowser({ tools });
  await assert.rejects(
    () => browser.tabs.get!("tab-1"),
    (error: unknown) => error instanceof CueLineError && error.code === "IAB_TAB_NOT_FOUND",
  );
});

test("tabs are listed in the open-tab shape the probe expects", async () => {
  const { tools } = fakeTools();
  const browser = createClaudeDesktopIabBrowser({ tools });
  assert.deepEqual(await browser.tabs.list?.(), [
    { id: "tab-1", url: "https://chatgpt.com/c/run-1", title: "Run 1" },
  ]);
});
