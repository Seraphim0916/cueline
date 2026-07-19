import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { canonicalJson, jobSpecHash } from "../../src/core/ids.js";

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

test("canonicalJson accepts plain objects created in another realm", () => {
  // A controller driving CueLine from a separate Node context produces plain
  // objects whose Object.prototype is a different realm identity. They are
  // ordinary data and must canonicalize exactly like same-realm objects.
  const foreign: unknown = vm.runInNewContext("({ b: 2, a: 1, nested: { deep: [true, null] } })");
  assert.equal(canonicalJson(foreign), canonicalJson({ b: 2, a: 1, nested: { deep: [true, null] } }));
  const foreignParsed: unknown = vm.runInNewContext(
    'JSON.parse(\'{"mode":"work","task":"t","workdir":"/w"}\')',
  );
  assert.equal(
    canonicalJson(foreignParsed),
    canonicalJson({ mode: "work", task: "t", workdir: "/w" }),
  );
});

test("canonicalJson still rejects non-plain objects from another realm", () => {
  for (const expression of [
    "new Date(0)",
    "new Map()",
    "new Set()",
    "/re/",
    "new Uint8Array([1])",
    "new (class Spec { x = 1 })()",
  ]) {
    const foreign: unknown = vm.runInNewContext(expression);
    assert.throws(
      () => canonicalJson(foreign),
      (error: unknown) =>
        error instanceof TypeError && /^CANONICAL_JSON_UNSUPPORTED_/.test(error.message),
      expression,
    );
  }
});

test("job spec hashes recompute for specs materialized in a controller realm", () => {
  // Regression: RunStore.load recomputes jobSpecHash over specs that reached the
  // state machine from a foreign Node controller realm; the cross-realm check
  // must not abort loading an otherwise valid persisted run.
  const spec = { mode: "work", task: "grounded-merge", workdir: "/tmp/w", timeoutMs: 1000 };
  const foreignSpec: unknown = vm.runInNewContext(
    `JSON.parse(${JSON.stringify(JSON.stringify(spec))})`,
  );
  assert.equal(jobSpecHash(foreignSpec), jobSpecHash(spec));
});
