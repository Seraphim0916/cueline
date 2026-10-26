import assert from "node:assert/strict";
import test from "node:test";
import { assertConversationUrlCompatible } from "../../dist/src/core/controller-turn.js";

const A = "https://chatgpt.com/c/conversation-a";
const B = "https://chatgpt.com/c/conversation-b";
const equivalentA = `${A}/?view=compact#latest`;
const mismatch = { code: "CONTROLLER_RECONCILIATION_CONVERSATION_MISMATCH" };

for (const [persisted, candidate, turnUrl] of [
  [A, A, B], [null, A, B], [A, B, A], [A, B, null],
  [A, undefined, B], [A, B, B],
]) {
  test(`reject every conflicting pair: ${JSON.stringify([persisted, candidate, turnUrl])}`, () => {
    const state = { conversationUrl: persisted };
    const turn = { conversationUrl: turnUrl };
    const before = structuredClone({ state, turn });
    assert.throws(() => assertConversationUrlCompatible(state, candidate, turn), mismatch);
    assert.deepEqual({ state, turn }, before);
  });
}

for (const [persisted, candidate, turnUrl, expected] of [
  [A, A, A, A], [A, equivalentA, equivalentA, A],
  [equivalentA, A, A, equivalentA],
  [null, A, equivalentA, equivalentA],
  [A, undefined, null, A], [null, A, null, A],
  [null, undefined, A, A], [null, undefined, null, null],
]) {
  test(`compatible or missing bindings preserve priority and original URL: ${JSON.stringify([persisted, candidate, turnUrl])}`, () => {
    const state = { conversationUrl: persisted };
    const turn = { conversationUrl: turnUrl };
    const before = structuredClone({ state, turn });
    assert.equal(assertConversationUrlCompatible(state, candidate, turn), expected);
    assert.deepEqual({ state, turn }, before);
  });
}

test("omitted turn and frozen inputs require no mutation", () => {
  assert.equal(assertConversationUrlCompatible(Object.freeze({ conversationUrl: null }), undefined), null);
  assert.equal(assertConversationUrlCompatible(Object.freeze({ conversationUrl: null }), A), A);
  assert.equal(assertConversationUrlCompatible(Object.freeze({ conversationUrl: A }), undefined), A);
  assert.equal(assertConversationUrlCompatible(Object.freeze({ conversationUrl: A }), equivalentA,
    Object.freeze({ conversationUrl: equivalentA })), A);
});
