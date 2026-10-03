import assert from "node:assert/strict";
import test from "node:test";

import { CueLineError } from "../../src/core/errors.js";
import { resolveClaudeDesktopBridgeRequestTimeoutMs } from "../../src/browser/claude-desktop/lane-options.js";
import { runClaudeDesktopLane } from "../../src/browser/claude-desktop/lane-runner.js";

// H-22: the Claude Desktop lane can resume an existing run, retries only the
// one failure that provably had no side effect, and stops with a resume hint.

const ready = { continueAllowed: true, safeNextAction: "continue", phase: "resume_ready" };

function unclaimedTimeout(): CueLineError {
  return new CueLineError("HOST_BRIDGE_TIMEOUT", "Host did not answer the browser request.", {
    details: { id: "req-1-1", method: "activeTab", claimed: false, timeoutMs: 120_000 },
  });
}

function harness(continueResults: Array<() => Promise<{ runId: string; status: string }>>) {
  const calls = { start: 0, continue: 0, browserUrls: [] as Array<string | undefined> };
  const records: Array<Record<string, unknown>> = [];
  const deps = {
    async startRun(request: string) {
      calls.start += 1;
      return { runId: `run-for-${request}`, status: "awaiting_controller" };
    },
    async continueRun(runId: string, _browser: unknown) {
      calls.continue += 1;
      const next = continueResults.shift();
      assert.ok(next, `unexpected continue #${String(calls.continue)} for ${runId}`);
      return next();
    },
    async loadStatus() {
      return ready;
    },
    async persistedConversationUrl(runId: string) {
      return runId === "run-existing" ? "https://chatgpt.com/c/existing-conversation" : undefined;
    },
    createBrowser(conversationUrl?: string) {
      calls.browserUrls.push(conversationUrl);
      return { conversationUrl };
    },
    async record(entry: Record<string, unknown>) {
      records.push(entry);
    },
    async sleep() {},
  };
  return { calls, records, deps };
}

test("resume skips run creation and drives the existing run with its saved conversation URL", async () => {
  const { calls, deps } = harness([async () => ({ runId: "run-existing", status: "complete" })]);

  const result = await runClaudeDesktopLane({
    ...deps,
    mode: { kind: "resume", runId: "run-existing" },
  });

  assert.equal(result.outcome, "finished");
  assert.equal(calls.start, 0);
  assert.equal(calls.continue, 1);
  assert.deepEqual(calls.browserUrls, ["https://chatgpt.com/c/existing-conversation"]);
});

test("an unclaimed bridge timeout is retried, then the run continues", async () => {
  const { calls, deps } = harness([
    async () => {
      throw unclaimedTimeout();
    },
    async () => {
      throw unclaimedTimeout();
    },
    async () => ({ runId: "run-existing", status: "complete" }),
  ]);

  const result = await runClaudeDesktopLane({
    ...deps,
    mode: { kind: "resume", runId: "run-existing" },
  });

  assert.equal(result.outcome, "finished");
  assert.equal(calls.continue, 3);
});

test("unclaimed timeout retries are capped at three, then the lane stops with a resume hint", async () => {
  const always = async () => {
    throw unclaimedTimeout();
  };
  const { calls, records, deps } = harness([always, always, always, always]);

  const result = await runClaudeDesktopLane({
    ...deps,
    mode: { kind: "resume", runId: "run-existing" },
  });

  assert.equal(result.outcome, "stopped");
  assert.equal(result.code, "HOST_BRIDGE_TIMEOUT");
  assert.equal(calls.continue, 4);
  assert.ok(
    records.some((entry) => typeof entry["resume"] === "string" && entry["resume"].includes("run-existing")),
  );
});

test("an outcome-unknown failure is never retried", async () => {
  const { calls, deps } = harness([
    async () => {
      throw new CueLineError(
        "HOST_BRIDGE_ACTION_OUTCOME_UNKNOWN",
        "Host claimed a side-effecting browser action but did not publish its outcome.",
        { details: { id: "req-1-1", method: "evaluate", claimed: true } },
      );
    },
  ]);

  const result = await runClaudeDesktopLane({
    ...deps,
    mode: { kind: "resume", runId: "run-existing" },
  });

  assert.equal(result.outcome, "stopped");
  assert.equal(result.code, "HOST_BRIDGE_ACTION_OUTCOME_UNKNOWN");
  assert.equal(calls.continue, 1);
});

test("the unclaimed request timeout is configurable and validated", () => {
  assert.equal(resolveClaudeDesktopBridgeRequestTimeoutMs({}), 120_000);
  assert.equal(
    resolveClaudeDesktopBridgeRequestTimeoutMs({ CUELINE_HOST_BRIDGE_REQUEST_TIMEOUT_MS: "300000" }),
    300_000,
  );
  assert.throws(() =>
    resolveClaudeDesktopBridgeRequestTimeoutMs({ CUELINE_HOST_BRIDGE_REQUEST_TIMEOUT_MS: "5s" }),
  );
});
