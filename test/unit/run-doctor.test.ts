import assert from "node:assert/strict";
import test from "node:test";

import { diagnoseCueLineRunStatus } from "../../src/diagnostics/run-doctor.js";
import type { CueLineRunStatusSummary } from "../../src/core/run-status.js";

function status(
  overrides: Partial<CueLineRunStatusSummary> = {},
): CueLineRunStatusSummary {
  return {
    runId: "run_doctor",
    status: "running",
    executor: "caller",
    allowProcessExecution: false,
    phase: "controller_response_pending",
    round: 2,
    maxRounds: 12,
    lastEventSequence: 17,
    runtime: { ownership: "released" },
    cancellation: { runRequested: false, jobRequests: [] },
    controller: {
      pendingTurns: 1,
      acceptedCommands: 1,
      responseAccepted: false,
      lastAcceptedAction: "dispatch",
      lastAcceptedRequestId: "msg_doctor",
      lastAcceptedJobKeys: ["audit"],
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
    safeNextAction: "observe",
    ...overrides,
  };
}

test("diagnoses a pending controller response without suggesting a resend", () => {
  const diagnosis = diagnoseCueLineRunStatus(status());

  assert.equal(diagnosis.outcome, "healthy");
  assert.equal(diagnosis.nextAction, "observe");
  assert.equal(diagnosis.findings[0]?.code, "CONTROLLER_RESPONSE_PENDING");
  assert.match(diagnosis.findings[0]?.action ?? "", /do not resend/i);
});

test("treats stale ownership and ambiguous local work as blockers", () => {
  const diagnosis = diagnoseCueLineRunStatus(
    status({
      phase: "runtime_stale",
      runtime: {
        ownership: "stale",
        ownerId: "owner_stale",
        heartbeatAt: "2026-07-15T00:00:00.000Z",
        ageMs: 90_000,
      },
      jobs: {
        total: 1,
        counts: {
          pending: 0,
          running: 0,
          succeeded: 0,
          failed: 0,
          timed_out: 0,
          cancelled: 0,
          ambiguous: 1,
          orphaned: 0,
        },
        items: [
          {
            jobId: "job_ambiguous",
            jobKey: "mutate",
            required: true,
            lane: "default",
            mode: "work",
            task: "Modify files",
            status: "ambiguous",
            persistedStatus: "ambiguous",
          },
        ],
      },
      continueAllowed: false,
      safeNextAction: "inspect_runtime",
    }),
  );

  assert.equal(diagnosis.outcome, "blocked");
  assert.deepEqual(
    diagnosis.findings.map((finding) => finding.code),
    ["RUNTIME_STALE", "AMBIGUOUS_JOB_PRESENT"],
  );
  assert.equal(diagnosis.findings[1]?.evidence.job_ids, "job_ambiguous");
});

test("distinguishes work proposed by Pro from work actually started", () => {
  const diagnosis = diagnoseCueLineRunStatus(
    status({
      phase: "caller_work_pending",
      controller: {
        pendingTurns: 0,
        acceptedCommands: 1,
        responseAccepted: true,
        lastAcceptedAction: "dispatch",
        lastAcceptedRequestId: "msg_doctor",
        lastAcceptedJobKeys: ["mutate"],
        archive: {
          enabled: false,
          status: "disabled",
          code: null,
          proof: null,
          postActionUrl: null,
        },
      },
      jobs: {
        total: 1,
        counts: {
          pending: 1,
          running: 0,
          succeeded: 0,
          failed: 0,
          timed_out: 0,
          cancelled: 0,
          ambiguous: 0,
          orphaned: 0,
        },
        items: [
          {
            jobId: "job_pending",
            jobKey: "mutate",
            required: true,
            lane: "default",
            mode: "work",
            task: "Modify files",
            status: "pending",
            persistedStatus: "pending",
            workClaim: { claimed: false, workdir: "/tmp/work" },
          },
        ],
      },
      continueAllowed: false,
      safeNextAction: "claim_caller_work",
    }),
  );

  assert.equal(diagnosis.outcome, "action_required");
  assert.equal(diagnosis.findings[0]?.code, "CALLER_WORK_NOT_STARTED");
  assert.match(diagnosis.summary, /has not started/i);
});

test("does not call a controller-blocked terminal result healthy", () => {
  const diagnosis = diagnoseCueLineRunStatus(
    status({
      status: "blocked",
      phase: "blocked",
      controller: {
        pendingTurns: 0,
        acceptedCommands: 1,
        responseAccepted: true,
        lastAcceptedAction: "blocked",
        lastAcceptedRequestId: "msg_blocked",
        lastAcceptedJobKeys: [],
        archive: {
          enabled: false,
          status: "disabled",
          code: null,
          proof: null,
          postActionUrl: null,
        },
      },
      continueAllowed: false,
      safeNextAction: "return_result",
    }),
  );

  assert.equal(diagnosis.outcome, "blocked");
  assert.equal(diagnosis.findings[0]?.code, "RUN_BLOCKED");
});
