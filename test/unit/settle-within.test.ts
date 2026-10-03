import assert from "node:assert/strict";
import test from "node:test";

import { settleWithin } from "../support/settle-within.js";

test("settleWithin returns the value of a promise that settles in time", async () => {
  assert.equal(await settleWithin(Promise.resolve(7), 1_000, "quick work"), 7);
});

test("settleWithin passes through the original rejection", async () => {
  await assert.rejects(settleWithin(Promise.reject(new Error("boom")), 1_000, "failing work"), /boom/);
});

test("settleWithin fails a promise that never settles, naming what hung", async () => {
  const started = performance.now();
  await assert.rejects(
    settleWithin(new Promise<never>(() => {}), 50, "MCP session close"),
    /MCP session close did not settle within 50ms/,
  );
  assert.ok(performance.now() - started < 1_000);
});
