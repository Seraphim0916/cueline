import { CueLineError } from "../../core/errors.js";
import type {
  IabBrowser,
  IabLocator,
  IabOpenTab,
  IabPlaywright,
  IabTab,
} from "../codex-iab/bootstrap.js";
import { findNodesByRole, parseAccessibilityTree, type A11yNode } from "./a11y-tree.js";
import type { ClaudeAgentBrowserTools, ClaudeAgentTabInfo } from "./agent-tools.js";

export interface ClaudeDesktopIabBrowserOptions {
  tools: ClaudeAgentBrowserTools;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Tagged transport keeps serialized JSON distinct from a literal page string. */
export type ClaudeDesktopEvaluateResultEnvelope =
  | {
      protocol: "cueline.evaluate-result/1";
      encoding: "json";
      value: string;
    }
  | {
      protocol: "cueline.evaluate-result/1";
      encoding: "literal";
      value: string;
    };

export function decodeEvaluateResult(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const envelope = raw as Record<string, unknown>;
  if (envelope["protocol"] !== "cueline.evaluate-result/1") return raw;
  if (typeof envelope["value"] !== "string") {
    throw new CueLineError(
      "HOST_BRIDGE_EVALUATE_ENVELOPE_MALFORMED",
      "Tagged evaluate result must carry a string value.",
    );
  }
  if (envelope["encoding"] === "literal") return envelope["value"];
  if (envelope["encoding"] !== "json") {
    throw new CueLineError(
      "HOST_BRIDGE_EVALUATE_ENVELOPE_MALFORMED",
      "Tagged evaluate result carries an unsupported encoding.",
    );
  }
  try {
    return JSON.parse(envelope["value"]) as unknown;
  } catch (error) {
    throw new CueLineError(
      "HOST_BRIDGE_EVALUATE_ENVELOPE_MALFORMED",
      "Tagged evaluate JSON result is malformed.",
      { cause: error },
    );
  }
}

/**
 * Wraps serialised page-function source so it evaluates standalone.
 *
 * `Function.prototype.toString` returns the source as the bundler left it, and
 * esbuild's keep-names transform rewrites `f` to `__name(f, "f")`. That helper
 * lives in this process's module scope, never in the page, so transported
 * source throws `ReferenceError: __name is not defined`. Supplying the binding
 * keeps the source itself untouched — rewriting it would change what the page
 * actually runs, which is exactly what must not happen.
 */
function standalone(call: string): string {
  return `(()=>{var __name=(target)=>target;return ${call};})()`;
}

function pasteIntoFocusedSource(text: string): string {
  const pageFunction = ({ text: payload }: { text: string }): unknown => {
    const active = document.activeElement as HTMLElement | null;
    const editables = Array.from(
      document.querySelectorAll<HTMLElement>('[contenteditable="true"]'),
    );
    const target = active?.isContentEditable
      ? active
      : editables.length === 1
        ? editables[0]!
        : null;
    if (target === null) {
      return {
        ok: false,
        reason: "editable_target_not_unique",
        editableCount: editables.length,
        activeTag: active?.tagName ?? null,
      };
    }
    target.focus();
    const selection = window.getSelection();
    if (selection !== null) {
      const range = document.createRange();
      range.selectNodeContents(target);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    const transfer = new DataTransfer();
    transfer.setData("text/plain", payload);
    const accepted = target.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
    // ChatGPT intentionally cancels the paste event after consuming it, so a
    // false dispatch return is evidence of preventDefault(), not action failure.
    return { ok: true, defaultPrevented: !accepted, length: payload.length };
  };
  return standalone(`(${pageFunction.toString()})(${JSON.stringify({ text })})`);
}

function makeLocator(
  tools: ClaudeAgentBrowserTools,
  tabId: string,
  role: string,
  name: string,
  sleep: (ms: number) => Promise<void>,
): IabLocator {
  const describe = `role=${role} name=${name}`;

  const matches = async (): Promise<A11yNode[]> => {
    const tree = await tools.readPage(tabId, { interactiveOnly: true });
    return findNodesByRole(parseAccessibilityTree(tree), role, name);
  };

  const requireRef = async (): Promise<string> => {
    const node = (await matches())[0];
    if (node === undefined) {
      throw new CueLineError("IAB_ELEMENT_NOT_FOUND", `No element matched ${describe}.`, {
        details: { target: describe, tabId },
      });
    }
    if (node.ref === undefined) {
      throw new CueLineError(
        "IAB_ELEMENT_REF_MISSING",
        `Element matching ${describe} carries no host handle.`,
        { details: { target: describe, tabId } },
      );
    }
    return node.ref;
  };

  return {
    async count() {
      return (await matches()).length;
    },
    async fill(value) {
      // ChatGPT converts an over-long prompt into a pasted-text attachment, and
      // only a paste event triggers that: a host fill tool leaves 11k+ chars
      // sitting inline, which is not the composer state the readers expect.
      // Request focus first, then reacquire the page's unique contenteditable
      // inside the evaluate call: Claude's tool boundary may return focus to
      // <main> between those two host operations.
      await tools.clickRef(tabId, await requireRef());
      await tools.evaluate(tabId, pasteIntoFocusedSource(value));
    },
    async click() {
      await tools.clickRef(tabId, await requireRef());
    },
    async waitFor({ state, timeoutMs }) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if ((await matches()).length > 0) return;
        if (Date.now() >= deadline) {
          throw new CueLineError(
            "IAB_ELEMENT_WAIT_TIMEOUT",
            `Timed out waiting for ${describe} to become ${state}.`,
            { details: { target: describe, timeoutMs } },
          );
        }
        await sleep(100);
      }
    },
    async isVisible() {
      // read_page lists rendered elements only, so presence is the visibility signal.
      return (await matches()).length > 0;
    },
    async isEnabled() {
      const node = (await matches())[0];
      return node !== undefined && !node.disabled;
    },
  };
}

function makePlaywright(
  tools: ClaudeAgentBrowserTools,
  tabId: string,
  sleep: (ms: number) => Promise<void>,
): IabPlaywright {
  // `locator` is intentionally not implemented: the host exposes no
  // deterministic CSS-to-handle path. Every caller guards on its absence, so
  // the CSS-selector fallbacks degrade instead of resolving elements by guess.
  return {
    getByRole(role, query) {
      return makeLocator(tools, tabId, role, query.name, sleep);
    },
    async evaluate<Result, Argument = undefined>(
      pageFunction: (argument: Argument) => Result | Promise<Result>,
      argument?: Argument,
    ): Promise<Result> {
      // Page functions are self-contained arrow functions taking a single
      // argument object, so source-text transport is equivalent to passing the
      // function itself. A closure over module scope would silently break here.
      const source = standalone(
        `(${pageFunction.toString()})(${JSON.stringify(argument ?? {})})`,
      );
      const raw = await tools.evaluate(tabId, source);
      return decodeEvaluateResult(raw) as Result;
    },
    async domSnapshot() {
      // Recovery readers text-search this for controller envelopes, so it must
      // carry message content: never the interactive-only tree.
      return tools.readPage(tabId);
    },
    async waitForTimeout(milliseconds) {
      await sleep(milliseconds);
    },
  };
}

function makeTab(
  tools: ClaudeAgentBrowserTools,
  info: ClaudeAgentTabInfo,
  sleep: (ms: number) => Promise<void>,
): IabTab {
  const tabId = info.tabId;
  return {
    id: tabId,
    async goto(url) {
      await tools.navigate(tabId, url);
    },
    async url() {
      // JSON has no undefined, so an absent URL always arrives as null.
      return (await tools.tabUrl(tabId)) ?? undefined;
    },
    async title() {
      return (await tools.tabTitle?.(tabId)) ?? info.title ?? "";
    },
    playwright: makePlaywright(tools, tabId, sleep),
  };
}

function toOpenTab(info: ClaudeAgentTabInfo): IabOpenTab {
  return info.title === undefined
    ? { id: info.tabId, url: info.url }
    : { id: info.tabId, url: info.url, title: info.title };
}

/**
 * Builds the browser object CueLine's codex-iab adapter already accepts through
 * `CodexIabAdapterOptions.browser`, backed by a Claude Code host's browser
 * tools. Nothing above this shim changes between the Codex and Claude Code
 * lanes: only the transport differs.
 */
export function createClaudeDesktopIabBrowser(
  options: ClaudeDesktopIabBrowserOptions,
): IabBrowser {
  const { tools } = options;
  const sleep = options.sleep ?? defaultSleep;

  const tabById = async (id: string): Promise<IabTab> => {
    const known = (await tools.listTabs()).find((tab) => tab.tabId === id);
    if (known === undefined) {
      throw new CueLineError("IAB_TAB_NOT_FOUND", "Requested tab is no longer open.", {
        details: { tabId: id },
      });
    }
    return makeTab(tools, known, sleep);
  };

  return {
    tabs: {
      async new() {
        // Claude Desktop's preview_start requires a concrete URL even though
        // the abstract IAB surface models opening a tab without arguments.
        return makeTab(tools, await tools.newTab("https://chatgpt.com/"), sleep);
      },
      async selected() {
        const active = await tools.activeTab();
        // A host with no focused controller tab answers null, not undefined:
        // JSON cannot carry undefined, so only a nullish check is safe here.
        return active == null ? undefined : makeTab(tools, active, sleep);
      },
      async list() {
        return (await tools.listTabs()).map(toOpenTab);
      },
      get: tabById,
    },
  };
}
