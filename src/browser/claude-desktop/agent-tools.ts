/**
 * Transport a Claude Code host fulfils with its own browser tools.
 *
 * Every method is one tool call that either performs a browser action or
 * returns raw evidence. None of them may interpret page semantics: all
 * ChatGPT-specific judgement stays in the shared codex-iab page scripts so both
 * host lanes derive controller evidence from one implementation.
 *
 * Deliberately absent: the host's natural-language element finder. It resolves
 * elements by asking a model, which would make element resolution vary run to
 * run. Resolution instead goes through `readPage` plus deterministic parsing.
 */

export interface ClaudeAgentTabInfo {
  tabId: string;
  url: string;
  title?: string;
}

export interface ClaudeAgentReadPageOptions {
  /**
   * Interactive-only trees are small and are what element resolution needs.
   * The full tree carries message text, which the recovery readers search, so
   * they must not be given a filtered one.
   */
  interactiveOnly?: boolean;
}

export interface ClaudeAgentBrowserTools {
  /**
   * A host whose browser surface is not open yet reports no tabs — an empty
   * list and no active tab. That is the true answer to "which tabs are open",
   * and it is the answer CueLine handles by opening one. Failing the request
   * instead aborts the run before it reaches that path. Genuine faults — a
   * crashed tool, a denied permission — still fail.
   */
  listTabs(): Promise<ClaudeAgentTabInfo[]>;
  activeTab(): Promise<ClaudeAgentTabInfo | undefined>;
  /** Opens the host's browser surface first when it is not already open. */
  newTab(url?: string): Promise<ClaudeAgentTabInfo>;
  navigate(tabId: string, url: string): Promise<void>;
  /**
   * Must be read from the page itself (`location.href`). A host's own tab
   * metadata was observed reporting the site root while the page sat on a
   * conversation URL, and tab matching rejects a controller tab on that
   * mismatch.
   */
  tabUrl(tabId: string): Promise<string | undefined>;
  tabTitle?(tabId: string): Promise<string | undefined>;

  /**
   * Runs `source` in the page and returns its completion value. `source` is a
   * self-contained expression; it never closes over host state.
   */
  evaluate(tabId: string, source: string): Promise<unknown>;

  /** Raw accessibility tree text, unsummarised and unmodified. */
  readPage(tabId: string, options?: ClaudeAgentReadPageOptions): Promise<string>;

  /**
   * Must dispatch a real user-level click on the element behind `ref`. A
   * synthetic `element.click()` does not reliably drive ChatGPT's composer, so
   * routing this through the page-script tool is not an acceptable
   * implementation.
   */
  clickRef(tabId: string, ref: string): Promise<void>;
}
