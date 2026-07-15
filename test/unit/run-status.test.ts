import assert from "node:assert/strict";
import test from "node:test";

import { summarizeCueLineRunState } from "../../src/core/run-status.js";
import {
  initialRunState,
  type ControllerSubmissionState,
  type CueLineRunState,
} from "../../src/core/state-machine.js";

function pendingState(
  submissionState: ControllerSubmissionState,
  manualSendConfirmed = false,
): CueLineRunState {
  return {
    ...initialRunState("run_status_pending", "Inspect", "caller"),
    round: 1,
    pendingControllerTurns: [
      {
        round: 1,
        requestId: "msg_status_pending",
        prompt: "controller prompt",
        promptHash: "prompt-hash",
        repairAttempt: 0,
        submissionState,
        conversationUrl: "https://chatgpt.com/c/exact",
        selectedModelLabel: "Pro",
        baselineAssistantMessageCount: 1,
        composerPromptState: "inline_ready",
        manualSendConfirmed,
      },
    ],
  };
}

test("a normally submitted Pro turn directs the caller to observe, not manual reconcile", () => {
  const summary = summarizeCueLineRunState(
    pendingState("submitted"),
    2,
    { ownership: "missing" },
  );

  assert.equal(summary.phase, "controller_response_pending");
  assert.equal(summary.safeNextAction, "observe");
});

test("ambiguous or manually submitted turns retain the explicit reconciliation action", () => {
  for (const state of [pendingState("possibly_sent"), pendingState("submitted", true)]) {
    const summary = summarizeCueLineRunState(state, 2, { ownership: "missing" });
    assert.equal(summary.safeNextAction, "reconcile");
  }
});

test("multiple submitted turns require explicit reconciliation selection", () => {
  const state = pendingState("submitted");
  state.pendingControllerTurns.push({
    ...state.pendingControllerTurns[0]!,
    round: 2,
    requestId: "msg_status_pending_second",
  });

  const summary = summarizeCueLineRunState(state, 3, { ownership: "missing" });
  assert.equal(summary.safeNextAction, "reconcile");
});

test("a requested turn with no write-ahead send checkpoint is retry-ready", () => {
  for (const status of ["running", "failed"] as const) {
    const state = pendingState("requested");
    state.status = status;
    state.conversationUrl = null;
    state.pendingControllerTurns[0]!.conversationUrl = null;
    state.pendingControllerTurns[0]!.submissionCheckpointContract = "write_ahead_v1";
    state.lastFailure =
      status === "failed"
        ? {
            code: "MODEL_SELECTOR_MISSING",
            requestId: state.pendingControllerTurns[0]!.requestId,
            message: "No send click was attempted.",
            stage: "pre_submit",
            submissionState: "definitely_not_sent",
            conversationUrl: null,
          }
        : null;

    const summary = summarizeCueLineRunState(state, 2, { ownership: "missing" });
    assert.equal(summary.phase, "prompt_not_sent");
    assert.equal(summary.safeNextAction, "retry");
    assert.equal(summary.controller.responseAccepted, false);
  }
});

test("process work exposes process execution, never a caller claim surface", () => {
  const state = initialRunState("run_process_work_status", "Execute", "process", 12, true);
  state.jobs.job_process_work = {
    jobId: "job_process_work",
    jobKey: "process_work",
    required: true,
    spec: {
      job_key: "process_work",
      lane: "default",
      mode: "work",
      task: "Explicit process work",
      workdir: "/tmp/process-work",
    },
    status: "running",
    output: null,
    error: null,
    callerWork: { claim: null, nextFencingToken: 0 },
    runtime: { runnerId: "codex-default", pid: 4242, phase: "running" },
  };

  const summary = summarizeCueLineRunState(state, 2, {
    ownership: "active",
    ownerId: "owner_process_work",
    heartbeatAt: "2026-07-15T00:00:00.000Z",
  });

  assert.equal(summary.jobs.items[0]?.workClaim, undefined);
  assert.equal(summary.jobs.items[0]?.execution?.runnerId, "codex-default");
  assert.equal(summary.jobs.items[0]?.execution?.pid, 4242);
});
