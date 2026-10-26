import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, commandHash } from "../../dist/src/core/ids.js";

const keys = ["a\u0000", "a\n", "e\u0301", "\u00e9", "😀", "\ue000"];
const entries = keys.map((key, index) => [key, `value ${index}: ${key}`]);

test("canonical Unicode keys use UTF-16 order and JSON escaping with lossless round trip", () => {
  const value = Object.fromEntries([...entries].reverse());
  const encoded = canonicalJson(value);
  assert.equal(encoded, '{"a\\u0000":"value 0: a\\u0000","a\\n":"value 1: a\\n","é":"value 2: é","é":"value 3: é","😀":"value 4: 😀","\ue000":"value 5: \ue000"}');
  assert.deepEqual(Object.keys(JSON.parse(encoded)), keys);
  assert.deepEqual(JSON.parse(encoded), value);
  assert.equal(encoded.includes("\u0000"), false);
  assert.equal(encoded.includes("\n"), false);
});

test("key insertion order does not affect canonical text or command hash", () => {
  const original = Object.fromEntries(entries);
  for (const order of [[...entries].reverse(), [...entries.slice(2), ...entries.slice(0, 2)]]) {
    const reordered = Object.fromEntries(order);
    assert.notDeepEqual(Object.keys(reordered), Object.keys(original));
    assert.equal(canonicalJson(reordered), canonicalJson(original));
    assert.equal(commandHash(reordered), commandHash(original));
  }
});

test("composed and decomposed Unicode remain distinct keys and hashes", () => {
  const composed = { "\u00e9": "same" };
  const decomposed = { "e\u0301": "same" };
  assert.notEqual(canonicalJson(composed), canonicalJson(decomposed));
  assert.notEqual(commandHash(composed), commandHash(decomposed));
  const both = JSON.parse(canonicalJson({ ...composed, ...decomposed }));
  assert.deepEqual(Object.keys(both), ["e\u0301", "\u00e9"]);
});
