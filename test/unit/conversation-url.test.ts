import assert from "node:assert/strict";
import test from "node:test";

import {
  isExactChatGptConversationUrl,
  normalizedConversationUrl,
  sameChatGptConversationUrl,
} from "../../src/core/conversation-url.js";

test("conversation URL identity ignores only benign browser decoration", () => {
  const canonical = "https://chatgpt.com/c/abc-123";
  const decorated = "https://chatgpt.com/c/abc-123/?utm_source=cueline#latest";

  assert.equal(isExactChatGptConversationUrl(canonical), true);
  assert.equal(isExactChatGptConversationUrl(decorated), true);
  assert.equal(normalizedConversationUrl(decorated), canonical);
  assert.equal(sameChatGptConversationUrl(canonical, decorated), true);
  assert.equal(
    sameChatGptConversationUrl(canonical, "https://chatgpt.com/c/another"),
    false,
  );
});

test("conversation URL identity rejects lookalike, credentialed, and nested URLs", () => {
  for (const value of [
    "http://chatgpt.com/c/abc-123",
    "https://example.com/c/abc-123",
    "https://user@chatgpt.com/c/abc-123",
    "https://chatgpt.com/c/abc-123/nested",
    "https://chatgpt.com/c/abc-123//",
    "https://chatgpt.com/c/",
    "https://chatgpt.com/c/abc_123",
  ]) {
    assert.equal(isExactChatGptConversationUrl(value), false, value);
    assert.equal(
      sameChatGptConversationUrl("https://chatgpt.com/c/abc-123", value),
      false,
      value,
    );
  }
});
