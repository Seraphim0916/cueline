import type {
  BrowserAdapter,
  BrowserConversationArchiveHooks,
  BrowserTurnInput,
  ControllerTurn,
} from "../../src/browser/browser-adapter.js";

export class FakeBrowserAdapter implements BrowserAdapter {
  readonly calls: BrowserTurnInput[] = [];
  readonly archiveCalls: string[] = [];
  archiveError: Error | null = null;
  readonly #turns: Array<ControllerTurn | ((input: BrowserTurnInput) => ControllerTurn)>;

  constructor(
    turns: Array<ControllerTurn | string | ((input: BrowserTurnInput) => ControllerTurn)>,
  ) {
    this.#turns = turns.map((turn) =>
      typeof turn === "string"
        ? {
            text: turn,
            conversationUrl: "https://chatgpt.com/c/fake-controller",
            model: {
              provider: "chatgpt",
              selectedLabel: "Pro",
              responseModelSlug: "gpt-5-6-pro",
              source: "composer_and_response",
            },
          }
        : turn,
    );
  }

  async sendTurn(input: BrowserTurnInput): Promise<ControllerTurn> {
    this.calls.push(structuredClone(input));
    const turn = this.#turns.shift();
    if (!turn) {
      throw new Error("FAKE_BROWSER_EXHAUSTED");
    }
    return structuredClone(typeof turn === "function" ? turn(input) : turn);
  }

  async archiveConversation(
    input: { conversationUrl: string },
    hooks: BrowserConversationArchiveHooks = {},
  ): Promise<{
    conversationUrl: string;
    proof: "conversation_url_changed";
    postActionUrl: string;
  }> {
    await hooks.onBeforeArchiveClick?.();
    this.archiveCalls.push(input.conversationUrl);
    if (this.archiveError) throw this.archiveError;
    return {
      conversationUrl: input.conversationUrl,
      proof: "conversation_url_changed",
      postActionUrl: "https://chatgpt.com/",
    };
  }
}
