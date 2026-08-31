import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAUDE_DESKTOP_IAB_TIMING_OPTIONS,
  resolveClaudeDesktopIabTimingOptions,
} from "../../src/browser/claude-desktop/lane-options.js";
import { CueLineError } from "../../src/core/errors.js";

test("Claude Desktop keeps a 120-second composer window without shrinking host operations", () => {
  assert.deepEqual(CLAUDE_DESKTOP_IAB_TIMING_OPTIONS, {
    composerReadyTimeoutMs: 120_000,
    browserOperationTimeoutMs: 180_000,
  });
  assert.equal(Object.isFrozen(CLAUDE_DESKTOP_IAB_TIMING_OPTIONS), true);
});

test("Claude Desktop resolves frozen default timing from an injected empty environment", () => {
  const resolved = resolveClaudeDesktopIabTimingOptions({});

  assert.deepEqual(resolved, CLAUDE_DESKTOP_IAB_TIMING_OPTIONS);
  assert.equal(Object.isFrozen(resolved), true);
});

test("Claude Desktop resolves each injected timing override and both together", () => {
  const composerOverride = resolveClaudeDesktopIabTimingOptions({
    CUELINE_COMPOSER_READY_TIMEOUT_MS: "900000",
  });
  assert.deepEqual(composerOverride, {
    composerReadyTimeoutMs: 900_000,
    browserOperationTimeoutMs: 180_000,
  });
  assert.equal(Object.isFrozen(composerOverride), true);

  const browserOverride = resolveClaudeDesktopIabTimingOptions({
    CUELINE_BROWSER_OPERATION_TIMEOUT_MS: "600000",
  });
  assert.deepEqual(browserOverride, {
    composerReadyTimeoutMs: 120_000,
    browserOperationTimeoutMs: 600_000,
  });
  assert.equal(Object.isFrozen(browserOverride), true);

  const bothOverrides = resolveClaudeDesktopIabTimingOptions({
    CUELINE_COMPOSER_READY_TIMEOUT_MS: "900000",
    CUELINE_BROWSER_OPERATION_TIMEOUT_MS: "600000",
  });
  assert.deepEqual(bothOverrides, {
    composerReadyTimeoutMs: 900_000,
    browserOperationTimeoutMs: 600_000,
  });
  assert.equal(Object.isFrozen(bothOverrides), true);
});

test("Claude Desktop accepts injected timeout range boundaries", () => {
  assert.equal(
    resolveClaudeDesktopIabTimingOptions({
      CUELINE_COMPOSER_READY_TIMEOUT_MS: "1000",
    }).composerReadyTimeoutMs,
    1_000,
  );
  assert.equal(
    resolveClaudeDesktopIabTimingOptions({
      CUELINE_BROWSER_OPERATION_TIMEOUT_MS: "3600000",
    }).browserOperationTimeoutMs,
    3_600_000,
  );
});

test("Claude Desktop rejects invalid injected timeout values without fallback", () => {
  const invalidValues: ReadonlyArray<readonly [string, string]> = [
    ["CUELINE_COMPOSER_READY_TIMEOUT_MS", "999"],
    ["CUELINE_COMPOSER_READY_TIMEOUT_MS", "3600001"],
    ["CUELINE_COMPOSER_READY_TIMEOUT_MS", ""],
    ["CUELINE_BROWSER_OPERATION_TIMEOUT_MS", "abc"],
    ["CUELINE_COMPOSER_READY_TIMEOUT_MS", "12.5"],
    ["CUELINE_COMPOSER_READY_TIMEOUT_MS", "-5"],
    ["CUELINE_COMPOSER_READY_TIMEOUT_MS", "0"],
    ["CUELINE_COMPOSER_READY_TIMEOUT_MS", " 120000 "],
  ];

  for (const [name, rawValue] of invalidValues) {
    assert.throws(
      () => resolveClaudeDesktopIabTimingOptions({ [name]: rawValue }),
      (error: unknown) =>
        error instanceof CueLineError &&
        error.code === "CLAUDE_DESKTOP_IAB_TIMING_OPTION_INVALID" &&
        error.message.includes(name) &&
        error.message.includes(JSON.stringify(rawValue)) &&
        error.message.includes("1000") &&
        error.message.includes("3600000"),
    );
  }
});
