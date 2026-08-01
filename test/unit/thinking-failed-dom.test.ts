import assert from "node:assert/strict";
import test from "node:test";

import {
  readPageChatState,
  type IabTab,
} from "../../src/browser/codex-iab/bootstrap.js";

const conversationUrl = "https://chatgpt.com/c/thinking-failed-dom-fixture";
const identity = {
  runId: "run_thinking_failed_dom_fixture",
  round: 24,
  requestId: "msg_thinking_failed_dom_fixture",
};
const prompt = `controller request ${identity.requestId}`;

interface FakeMessage {
  role: "user" | "assistant";
  text: string;
  modelSlug?: string;
}

function fakeTab(messages: FakeMessage[]): IabTab {
  const elements = messages.map((message) => ({
    innerText: message.text,
    textContent: message.text,
    getAttribute(name: string) {
      if (name === "data-message-author-role") return message.role;
      if (name === "data-message-model-slug") return message.modelSlug ?? null;
      return null;
    },
    closest() {
      return this;
    },
    querySelectorAll() {
      return [];
    },
  }));
  return {
    async goto(): Promise<void> {},
    async url(): Promise<string> {
      return conversationUrl;
    },
    playwright: {
      getByRole(): never {
        throw new Error("locator not used by read-only fixture");
      },
      async evaluate<Result, Argument>(
        pageFunction: (argument: Argument) => Result | Promise<Result>,
        argument?: Argument,
      ): Promise<Result> {
        const priorDocument = globalThis.document;
        const priorWindow = globalThis.window;
        const fakeDocument = {
          querySelectorAll(selector: string) {
            if (selector === "button") return [];
            if (selector === "[data-message-author-role]") return elements;
            if (selector === "[data-message-model-slug]") {
              return elements.filter((element) =>
                element.getAttribute("data-message-model-slug") !== null
              );
            }
            return [];
          },
        };
        Object.assign(globalThis, {
          document: fakeDocument,
          window: { location: { href: conversationUrl } },
        });
        try {
          return await pageFunction(argument as Argument);
        } finally {
          Object.assign(globalThis, {
            document: priorDocument,
            window: priorWindow,
          });
        }
      },
      async domSnapshot(): Promise<string> {
        return "";
      },
      async waitForTimeout(): Promise<void> {},
    },
  };
}

test("readPageChatState returns exact Thinking failed response evidence for current turn", async () => {
  const state = await readPageChatState(
    fakeTab([
      { role: "user", text: prompt },
      { role: "assistant", text: "Thinking failed", modelSlug: "gpt-5-6-pro" },
    ]),
    identity,
    prompt,
  );
  assert.deepEqual(state.responseFailure, {
    code: "CHATGPT_THINKING_FAILED",
    message: "Thinking failed",
    retryActionAvailable: false,
  });
  assert.equal(state.requestMessageFound, true);
  assert.equal(state.lastMessageRole, "assistant");
  assert.equal(state.isAnswering, false);
});

test("historical Thinking failed is ignored when current assistant leaf differs", async () => {
  const state = await readPageChatState(
    fakeTab([
      { role: "user", text: "older request" },
      { role: "assistant", text: "Thinking failed", modelSlug: "gpt-5-6-pro" },
      { role: "user", text: prompt },
      { role: "assistant", text: "Current response is healthy", modelSlug: "gpt-5-6-pro" },
    ]),
    identity,
    prompt,
  );
  assert.equal(state.responseFailure, null);
  assert.equal(state.assistantText, "Current response is healthy");
});
