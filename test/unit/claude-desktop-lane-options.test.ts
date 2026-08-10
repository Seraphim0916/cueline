import assert from "node:assert/strict";
import test from "node:test";

import { CLAUDE_DESKTOP_IAB_TIMING_OPTIONS } from "../../src/browser/claude-desktop/lane-options.js";

test("Claude Desktop keeps a 120-second composer window without shrinking host operations", () => {
  assert.deepEqual(CLAUDE_DESKTOP_IAB_TIMING_OPTIONS, {
    composerReadyTimeoutMs: 120_000,
    browserOperationTimeoutMs: 180_000,
  });
  assert.equal(Object.isFrozen(CLAUDE_DESKTOP_IAB_TIMING_OPTIONS), true);
});
