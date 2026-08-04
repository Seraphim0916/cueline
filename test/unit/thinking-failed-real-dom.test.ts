import assert from "node:assert/strict";
import test from "node:test";

import {
  readPageChatState,
  type IabTab,
} from "../../src/browser/codex-iab/bootstrap.js";

const conversationUrl = "https://chatgpt.com/c/thinking-failed-real-dom";
const identity = {
  runId: "run_thinking_failed_real_dom",
  round: 24,
  requestId: "msg_thinking_failed_real_dom",
};
const prompt = `controller request ${identity.requestId}`;

function element(
  text: string,
  attributes: Record<string, string | null> = {},
) {
  return {
    innerText: text,
    textContent: text,
    getAttribute(name: string) {
      return attributes[name] ?? null;
    },
    closest() {
      return this;
    },
    querySelectorAll() {
      return [];
    },
  };
}

function realDomFailureTab(
  turnTexts = ["ChatGPT said: Thinking failed"],
  buttonTexts: string[] = [],
): IabTab {
  const currentUser = element(prompt, {
    "data-message-author-role": "user",
  });
  const priorAssistant = element("Prior healthy controller response", {
    "data-message-author-role": "assistant",
    "data-message-model-slug": "gpt-5-6-pro",
  });
  const conversationTurns = turnTexts.map((text, index) =>
    element(text, {
      "data-testid": `conversation-turn-${1028 + index}`,
    }),
  );
  const buttons = buttonTexts.map((text) => element(text));
  const messages = [priorAssistant, currentUser];

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
          if (selector === "button") return buttons;
            if (selector === "[data-message-author-role]") return messages;
            if (selector === "[data-message-model-slug]") {
              return [priorAssistant];
            }
            if (selector === 'section[data-testid^="conversation-turn-"]') {
              return conversationTurns;
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

test("real ChatGPT detached Thinking failed turn is current assistant failure", async () => {
  const state = await readPageChatState(realDomFailureTab(), identity, prompt);

  assert.deepEqual(state.responseFailure, {
    code: "CHATGPT_THINKING_FAILED",
    message: "Thinking failed",
    retryActionAvailable: false,
  });
  assert.equal(state.responseFailureFoundBy, "conversation_turn");
  assert.equal(state.requestMessageFound, true);
  assert.equal(state.lastMessageRole, "assistant");
  assert.equal(state.assistantText, "Thinking failed");
  assert.equal(state.isAnswering, false);
});

test("historical detached Thinking failed turn is ignored when a newer turn exists", async () => {
  const state = await readPageChatState(
    realDomFailureTab([
      "ChatGPT said: Thinking failed",
      "ChatGPT said: Current response is healthy",
    ]),
    identity,
    prompt,
  );

  assert.equal(state.responseFailure, null);
});

test("detached Stopped thinking turn is normalized to Thinking failed", async () => {
  const state = await readPageChatState(
    realDomFailureTab(["Stopped thinking"], ["Stopped thinking"]),
    identity,
    prompt,
  );

  assert.deepEqual(state.responseFailure, {
    code: "CHATGPT_THINKING_FAILED",
    message: "Thinking failed",
    retryActionAvailable: false,
  });
  assert.equal(state.responseFailureFoundBy, "conversation_turn");
  assert.equal(state.requestMessageFound, true);
  assert.equal(state.lastMessageRole, "assistant");
  assert.equal(state.assistantText, "Thinking failed");
  assert.equal(state.isAnswering, false);
});
