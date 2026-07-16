import assert from "node:assert/strict";
import test from "node:test";

import { safeCueLineRunStatus } from "../../src/cli/run-status-view.js";
import type { CueLineRunStatusSummary } from "../../src/core/run-status.js";

test("the CLI run status view is an explicit metadata allowlist", () => {
  const status: CueLineRunStatusSummary & { futureSecret: string } = {
    runId: "run_safe_status",
    status: "running",
    executor: "caller",
    allowProcessExecution: false,
    phase: "caller_work_claimed",
    round: 2,
    maxRounds: 12,
    lastEventSequence: 9,
    runtime: {
      ownership: "active",
      ownerId: "owner-secret",
      pid: "4242",
      heartbeatAt: "2026-07-15T00:00:00.000Z",
      ageMs: 500,
    },
    cancellation: { runRequested: false, jobRequests: [] },
    controller: {
      pendingTurns: 0,
      acceptedCommands: 1,
      responseAccepted: true,
      lastAcceptedAction: "dispatch",
      lastAcceptedRequestId: "msg_safe_status",
      lastAcceptedJobKeys: ["local_work"],
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
          jobId: "job_safe_status",
          jobKey: "local_work",
          required: true,
          lane: "default",
          mode: "work",
          task: "SECRET_TASK_BODY",
          status: "pending",
          persistedStatus: "pending",
          workClaim: {
            claimed: true,
            callerId: "SECRET_CALLER_ID",
            taskHash: "SECRET_TASK_HASH",
            workdir: "/Users/private/SECRET_WORKDIR",
            claimedAt: "2026-07-15T00:00:00.000Z",
            heartbeatAt: "2026-07-15T00:00:01.000Z",
            expiresAt: "2026-07-15T00:05:00.000Z",
            startedAt: null,
          },
          execution: {
            runnerId: "codex-default",
            pid: 4242,
            model: "gpt-5.6-sol",
            provider: "openai",
            phase: "running",
            lastProgressAt: "2026-07-15T00:00:02.000Z",
          },
        },
      ],
    },
    continueAllowed: false,
    safeNextAction: "start_caller_work",
    futureSecret: "SECRET_FUTURE_FIELD",
  };

  const safe = safeCueLineRunStatus(status);
  const serialized = JSON.stringify(safe);

  assert.doesNotMatch(
    serialized,
    /SECRET_TASK_BODY|SECRET_CALLER_ID|SECRET_TASK_HASH|SECRET_WORKDIR|SECRET_FUTURE_FIELD|owner-secret/,
  );
  assert.deepEqual(safe.runtime, {
    ownership: "active",
    heartbeatAt: "2026-07-15T00:00:00.000Z",
    ageMs: 500,
    pid: "4242",
  });
  assert.deepEqual(safe.jobs.items[0]?.workClaim, {
    claimed: true,
    claimedAt: "2026-07-15T00:00:00.000Z",
    heartbeatAt: "2026-07-15T00:00:01.000Z",
    expiresAt: "2026-07-15T00:05:00.000Z",
    startedAt: null,
  });
  assert.deepEqual(safe.jobs.items[0]?.execution, status.jobs.items[0]?.execution);
});

test("the CLI archive status never exposes a ChatGPT conversation URL", () => {
  const status = {
    runId: "run_safe_archive_status",
    status: "complete",
    executor: "caller",
    allowProcessExecution: false,
    phase: "complete",
    round: 1,
    maxRounds: 12,
    lastEventSequence: 5,
    runtime: { ownership: "released" },
    cancellation: { runRequested: false, jobRequests: [] },
    controller: {
      pendingTurns: 0,
      acceptedCommands: 1,
      responseAccepted: true,
      lastAcceptedAction: "complete",
      lastAcceptedRequestId: "msg_safe_archive_status",
      lastAcceptedJobKeys: [],
      archive: {
        enabled: true,
        status: "archived",
        code: null,
        proof: "conversation_url_changed",
        postActionUrl: "https://chatgpt.com/c/SECRET_ARCHIVE_DESTINATION",
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
    continueAllowed: false,
    safeNextAction: "return_result",
  } satisfies CueLineRunStatusSummary;

  const safe = safeCueLineRunStatus(status);
  const serialized = JSON.stringify(safe);

  assert.doesNotMatch(serialized, /SECRET_ARCHIVE_DESTINATION|postActionUrl/);
  assert.deepEqual(safe.controller.archive, {
    enabled: true,
    status: "archived",
    code: null,
    proof: "conversation_url_changed",
  });
});
