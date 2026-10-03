import assert from "node:assert/strict";
import test from "node:test";

import { asCueLineError, CueLineError } from "../../src/core/errors.js";

const circular: Record<string, unknown> = {};
circular.self = circular;

const cases: Array<{ name: string; value: unknown; type: string; rendering?: string }> = [
  { name: "undefined", value: undefined, type: "undefined" },
  { name: "null", value: null, type: "(null)", rendering: "null" },
  { name: "string", value: "adapter rejected the turn", type: "string", rendering: "adapter rejected the turn" },
  { name: "number", value: 42, type: "number", rendering: "42" },
  { name: "boolean", value: false, type: "boolean", rendering: "false" },
  { name: "plain object", value: { reason: "adapter unavailable" }, type: "object", rendering: '{"reason":"adapter unavailable"}' },
  { name: "array", value: ["adapter", 42], type: "object", rendering: '["adapter",42]' },
  { name: "long object", value: { reason: "x".repeat(1_000) }, type: "object", rendering: '[truncated]' },
  { name: "circular object", value: circular, type: "object", rendering: "[unserializable value]" },
  { name: "throwing toJSON", value: { toJSON() { throw new Error("cannot serialize"); } }, type: "object", rendering: "[unserializable value]" },
  { name: "symbol", value: Symbol("adapter"), type: "symbol", rendering: "Symbol(adapter)" },
  { name: "bigint", value: 42n, type: "bigint", rendering: "42" },
];

for (const { name, value, type, rendering } of cases) {
  test(`asCueLineError describes a rejected ${name} without throwing`, () => {
    const error = asCueLineError(value);
    assert.ok(error.message.length > 0);
    assert.ok(error.message.length <= 300);
    assert.ok(!["undefined", "null", "[object Object]"].includes(error.message));
    assert.ok(error.message.includes(type));
    if (rendering) assert.ok(error.message.includes(rendering));
    if (name === "long object") {
      assert.ok(error.message.includes('{"reason":"xxx'));
      assert.ok(error.message.endsWith("… [truncated]"));
      assert.ok(error.message.split(": ").slice(1).join(": ").length <= 240);
    }
    assert.equal(error.code, "CUELINE_INTERNAL");
    assert.equal(error.cause, value);
  });
}

test("asCueLineError preserves real Error messages byte for byte and retains the cause", () => {
  for (const message of ["browser.sendTurn is not a function", "", "undefined", "null", "[object Object]", "  adapter\nfailed\u0000  "]) {
    const original = new Error(message);
    const error = asCueLineError(original, "CUSTOM_CODE");
    assert.equal(error.message, message);
    assert.equal(error.code, "CUSTOM_CODE");
    assert.equal(error.cause, original);
  }
});

test("asCueLineError returns CueLineError instances unchanged", () => {
  const original = new CueLineError("ORIGINAL_CODE", "original message", { cause: 42, details: { retry: false } });
  assert.equal(asCueLineError(original, "OTHER_CODE"), original);
});
