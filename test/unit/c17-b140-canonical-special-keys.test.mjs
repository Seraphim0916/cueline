import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson } from "../../dist/src/core/ids.js";

const expected = '{"__proto__":{"x":1},"constructor":2,"toString":3}';
const keys = ["__proto__", "constructor", "toString"];

for (const construction of ["JSON.parse", "null prototype"]) {
  test(`canonical JSON preserves special own keys from ${construction}`, () => {
    const before = Object.getOwnPropertyDescriptors(Object.prototype);
    const value = construction === "JSON.parse"
      ? JSON.parse('{"toString":3,"constructor":2,"__proto__":{"x":1}}')
      : Object.assign(Object.create(null), JSON.parse('{"toString":3,"constructor":2,"__proto__":{"x":1}}'));
    const prototype = Object.getPrototypeOf(value);
    assert.deepEqual(Object.keys(value), [...keys].reverse());
    for (const key of keys) assert.equal(Object.hasOwn(value, key), true);

    const encoded = canonicalJson(value);
    assert.equal(encoded, expected);
    const decoded = JSON.parse(encoded);
    assert.deepEqual(Object.keys(decoded), keys);
    for (const key of keys) {
      assert.equal(Object.hasOwn(decoded, key), true);
      assert.deepEqual(decoded[key], value[key]);
    }
    assert.equal(canonicalJson(decoded), expected);
    assert.equal(Object.getPrototypeOf(value), prototype);
    assert.equal(Object.getPrototypeOf(decoded), Object.prototype);
    assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), before);
    assert.equal(Object.hasOwn(Object.prototype, "x"), false);
    assert.equal(({}).x, undefined);
  });
}
