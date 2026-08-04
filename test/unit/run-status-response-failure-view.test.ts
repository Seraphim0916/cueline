import assert from "node:assert/strict";
import test from "node:test";

import { safeCueLineRunStatus } from "../../src/core/run-status-view.js";
import type { CueLineRunStatusSummary } from "../../src/core/run-status.js";

test("CLI status exposes bounded Thinking failed retry identity", () => {
  const status = {
    runId: "run_response_failure_status",
    status: "running",
    executor: "caller",
    allowProcessExecution: false,
    phase: "controller_response_failed",
    round: 24,
    maxRounds: null,
    maxStagnantRounds: 12,
    stagnantRounds: 0,
    lastProgressFingerprint: null,
    lastEventSequence: 543,
    runtime: { ownership: "missing" },
    cancellation: { runRequested: false, jobRequests: [] },
    controller: {
      pendingTurns: 1,
      acceptedCommands: 23,
      responseAccepted: false,
      lastAcceptedAction: "inspect",
      lastAcceptedRequestId: "msg_previous",
      lastAcceptedJobKeys: [],
      responseFailure: {
        requestId: "msg_failed",
        round: 24,
        code: "CHATGPT_THINKING_FAILED",
        evidenceHash:
          "f1674cd031746c69b91893c0b5524ab51a775912252ac9e79de19ccd933bcd40",
        retryActionAvailable: false,
        status: "observed",
      },
      archive: {
        enabled: false,
        status: "disabled",
        code: null,
        proof: null,
        postActionUrl: null,
      },
    },
    jobs: {
      total: 0,
      counts: {
        pending: 0,
        running: 0,
        succeeded: 0,
        failed: 0,
        timed_out: 0,
        cancelled: 0,
        ambiguous: 0,
        orphaned: 0,
      },
      items: [],
    },
    continueAllowed: true,
    safeNextAction: "authorize_controller_response_retry",
  } satisfies CueLineRunStatusSummary;

  const safe = safeCueLineRunStatus(status);

  assert.deepEqual(
    (safe.controller as unknown as Record<string, unknown>).responseFailure,
    status.controller.responseFailure,
  );
});
