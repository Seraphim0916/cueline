import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isExactChatGptConversationUrl,
  normalizedConversationUrl,
  sameChatGptConversationUrl,
} from '../../dist/src/core/conversation-url.js';

const ids = ['Ab-1', 'ab-1', 'other-2'];
const groups = ids.map(id => [
  `https://chatgpt.com/c/${id}`,
  `https://chatgpt.com/c/${id}/`,
  `https://chatgpt.com:443/c/${id}/?x=1#z`,
  `https://CHATGPT.COM/c/${id}?x=2&y=3#latest`,
  `https://chatgpt.com/c/${id}#fragment`,
]);

test('valid decorated URLs normalize to a stable canonical URL', () => {
  groups.forEach((group, index) => {
    for (const url of group) {
      assert.equal(isExactChatGptConversationUrl(url), true, url);
      const normalized = normalizedConversationUrl(url);
      assert.equal(normalized, `https://chatgpt.com/c/${ids[index]}`);
      assert.equal(normalizedConversationUrl(normalized), normalized);
      assert.equal(sameChatGptConversationUrl(url, url), true);
    }
  });
});

test('equivalence is symmetric across all groups and preserves identifier case', () => {
  groups.forEach((leftGroup, i) => groups.forEach((rightGroup, j) => {
    for (const left of leftGroup) {
      for (const right of rightGroup) {
        const forward = sameChatGptConversationUrl(left, right);
        const reverse = sameChatGptConversationUrl(right, left);
        assert.equal(forward, reverse, `${left} vs ${right}`);
        assert.equal(forward, i === j, `${left} vs ${right}`);
      }
    }
  }));
});

test('equivalence is transitive for every triple of legal URL variants', () => {
  for (const group of groups) {
    for (const a of group) for (const b of group) for (const c of group) {
      // Assert the premises too: a comparator that always returns false must fail.
      assert.equal(sameChatGptConversationUrl(a, b), true);
      assert.equal(sameChatGptConversationUrl(b, c), true);
      assert.equal(sameChatGptConversationUrl(a, c), true);
    }
  }
});

test('lookalike hosts and non-default ports never match legal variants', () => {
  for (const invalid of [
    'https://chatgpt.com.evil/c/Ab-1',
    'https://chatgpt.com:444/c/Ab-1',
    'http://chatgpt.com/c/Ab-1',
  ]) {
    assert.equal(isExactChatGptConversationUrl(invalid), false);
    for (const valid of groups[0]) {
      assert.equal(sameChatGptConversationUrl(valid, invalid), false);
      assert.equal(sameChatGptConversationUrl(invalid, valid), false);
    }
  }
});
