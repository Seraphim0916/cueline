import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson } from "../../src/core/ids.js";

test("canonicalJson serializes plain, null-prototype, and array values", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  const nullProto = Object.assign(Object.create(null) as Record<string, unknown>, { z: true });
  assert.equal(canonicalJson(nullProto), '{"z":true}');
  assert.equal(canonicalJson([1, { a: 1 }]), '[1,{"a":1}]');
  assert.equal(canonicalJson({ nested: { deep: [true, null] } }), '{"nested":{"deep":[true,null]}}');
});

test("canonicalJson rejects non-plain objects instead of silently emitting {}", () => {
  // Date/Map/Set/RegExp/typed arrays have zero own enumerable keys; the old
  // fall-through canonicalized them to "{}" and durably persisted a wrong value.
  for (const value of [new Date(), new Map(), new Set(), /re/, new Uint8Array([1])]) {
    assert.throws(
      () => canonicalJson(value),
      (error: unknown) =>
        error instanceof TypeError && /^CANONICAL_JSON_UNSUPPORTED_/.test(error.message),
    );
    assert.throws(
      () => canonicalJson({ field: value }),
      (error: unknown) =>
        error instanceof TypeError && /^CANONICAL_JSON_UNSUPPORTED_/.test(error.message),
    );
  }
});
