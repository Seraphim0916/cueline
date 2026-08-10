import assert from "node:assert/strict";
import test from "node:test";

import { waitForCueLineLaneContinuation } from "../../src/browser/claude-desktop/lane-status-guard.js";

test("durable status blocks continuation until continueAllowed becomes true", async () => {
  const statuses = [
    { continueAllowed: false, safeNextAction: "claim_caller_work" },
    { continueAllowed: false, safeNextAction: "continue_caller_work" },
    { continueAllowed: true, safeNextAction: "continue" },
  ];
  const blocked: unknown[] = [];
  const sleeps: number[] = [];
  const result = await waitForCueLineLaneContinuation("run-1", {
    async loadStatus() {
      const status = statuses.shift();
      assert.ok(status);
      return status;
    },
    async onBlocked(status) {
      blocked.push(status.safeNextAction);
    },
    async sleep(ms) {
      sleeps.push(ms);
    },
    pollIntervalMs: 25,
  });

  assert.equal(result.continueAllowed, true);
  assert.deepEqual(blocked, ["claim_caller_work", "continue_caller_work"]);
  assert.deepEqual(sleeps, [25, 25]);
});
