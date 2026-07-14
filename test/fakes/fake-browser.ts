import type {
  BrowserAdapter,
  BrowserTurnInput,
  ControllerTurn,
} from "../../src/browser/browser-adapter.js";

export class FakeBrowserAdapter implements BrowserAdapter {
  readonly calls: BrowserTurnInput[] = [];
  readonly #turns: Array<ControllerTurn | ((input: BrowserTurnInput) => ControllerTurn)>;

  constructor(
    turns: Array<ControllerTurn | string | ((input: BrowserTurnInput) => ControllerTurn)>,
  ) {
    this.#turns = turns.map((turn) => (typeof turn === "string" ? { text: turn } : turn));
  }

  async sendTurn(input: BrowserTurnInput): Promise<ControllerTurn> {
    this.calls.push(structuredClone(input));
    const turn = this.#turns.shift();
    if (!turn) {
      throw new Error("FAKE_BROWSER_EXHAUSTED");
    }
    return structuredClone(typeof turn === "function" ? turn(input) : turn);
  }
}
