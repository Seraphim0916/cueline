import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rename, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_CALLER_WORK_HEARTBEAT_INTERVAL_MS,
  DEFAULT_CALLER_WORK_MAX_EXECUTION_MS,
  DEFAULT_CALLER_WORK_PROGRESS_TIMEOUT_MS,
  claimCueLineCallerJob,
  continueCueLineRun,
  heartbeatCueLineCallerJob,
  loadCueLineRunState,
  loadCueLineRunStatus,
  recordCueLineCallerJobProgress,
  releaseCueLineCallerJob,
  runCueLine,
  startCueLineCallerJob,
  startCueLineCallerWorkLease,
  submitCueLineCallerJobResult,
} from "../../src/api.js";
import type { BrowserTurnInput, ControllerTurn } from "../../src/browser/browser-adapter.js";
import { CueLineError } from "../../src/core/errors.js";
import { jobSpecHash } from "../../src/core/ids.js";
import { loadPersistedRunStore } from "../../src/core/persisted-run.js";
import { reduceRunState } from "../../src/core/state-machine.js";
import { JobStatusStore } from "../../src/jobs/status.js";
import type { RunEvent } from "../../src/state/event-log.js";
import { readEvents } from "../../src/state/event-log.js";
import { runPaths } from "../../src/state/paths.js";
import { RuntimeLease } from "../../src/state/runtime-lease.js";
import { FakeBrowserAdapter } from "../fakes/fake-browser.js";

function reply(
  command: (input: BrowserTurnInput) => Record<string, unknown>,
): (input: BrowserTurnInput) => ControllerTurn {
  return (input) => ({
    text: `<CueLineControl>${JSON.stringify({
      protocol: "cueline/0.1",
      run_id: input.runId,
      round: input.round,
      request_id: input.requestId,
      ...command(input),
    })}</CueLineControl>`,
    conversationUrl: "https://chatgpt.com/c/caller-work-claim-test",
    model: {
      provider: "chatgpt",
      selectedLabel: "Pro",
      responseModelSlug: "gpt-5-6-pro",
      source: "composer_and_response",
    },
  });
}

async function fixture(runId: string, maxJobEvidenceChars?: number) {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-claim-"));
  const workdir = path.join(home, "workspace");
  await mkdir(workdir);
  const result = await runCueLine({
    request: "Have the current Codex perform one explicit local edit",
    runId,
    home,
    ...(maxJobEvidenceChars === undefined ? {} : { maxJobEvidenceChars }),
    browser: new FakeBrowserAdapter([
      reply(() => ({
        action: "dispatch",
        jobs: [
          {
            job_key: "local_work",
            lane: "default",
            mode: "work",
            task: "Edit the exact workspace only after a durable caller claim.",
            workdir,
          },
        ],
      })),
    ]),
    routingConfig: {
      version: 1,
      lanes: {
        default: {
          enabled: true,
          candidates: [
            {
              id: "must-not-spawn",
              argv: [process.execPath, "-e", "process.exit(99)"],
              task_input: "stdin",
            },
          ],
        },
      },
    },
  });
  assert.equal(result.status, "awaiting_caller_work");
  const job = Object.values(result.state.jobs)[0]!;
  return { home, workdir, job, result };
}

function proof(claim: {
  claimId: string;
  callerId: string;
  fencingToken: number;
}) {
  return {
    claimId: claim.claimId,
    callerId: claim.callerId,
    fencingToken: claim.fencingToken,
  };
}

function event(type: string, payload: unknown): RunEvent {
  return {
    sequence: 1,
    timestamp: "2026-07-15T00:00:00.000Z",
    type,
    payload,
  };
}

test("two callers racing to claim one work job produce exactly one valid claim", async () => {
  const { home, workdir, job } = await fixture("run_caller_claim_race");
  const attempts = await Promise.allSettled([
    claimCueLineCallerJob("run_caller_claim_race", job.jobId, {
      home,
      callerId: "codex-window-a",
    }),
    claimCueLineCallerJob("run_caller_claim_race", job.jobId, {
      home,
      callerId: "codex-window-b",
    }),
  ]);
  const fulfilled = attempts.filter(
    (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof claimCueLineCallerJob>>> =>
      attempt.status === "fulfilled",
  );
  const rejected = attempts.filter((attempt) => attempt.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(fulfilled[0]!.value.workdir, workdir);
  assert.equal(fulfilled[0]!.value.task, job.spec.task);
  assert.match(fulfilled[0]!.value.taskHash, /^[a-f0-9]{64}$/);
  assert.equal(fulfilled[0]!.value.started, false);
});

test("the same caller can recover an active claim after losing the API response", async () => {
  const runId = "run_caller_claim_idempotent_recovery";
  const { home, job } = await fixture(runId);
  const first = await claimCueLineCallerJob(runId, job.jobId, {
    home,
    callerId: "codex-stable-caller",
  });
  const recovered = await claimCueLineCallerJob(runId, job.jobId, {
    home,
    callerId: "codex-stable-caller",
  });

  assert.equal(recovered.outcome, "already_claimed");
  assert.equal(recovered.claimId, first.claimId);
  assert.equal(recovered.fencingToken, first.fencingToken);
  assert.equal(recovered.taskHash, first.taskHash);
  assert.equal(recovered.workdir, first.workdir);
  await startCueLineCallerJob(runId, job.jobId, proof(recovered), { home });
  const recoveredAfterStart = await claimCueLineCallerJob(runId, job.jobId, {
    home,
    callerId: "codex-stable-caller",
  });
  assert.equal(recoveredAfterStart.claimId, first.claimId);
  assert.equal(recoveredAfterStart.started, true);
  const events = await readEvents(runPaths(home, runId).events);
  assert.equal(events.filter((entry) => entry.type === "caller_work_claimed").length, 1);
});

test("caller work start rejects a workdir symlink retargeted after claim", async () => {
  const runId = "run_caller_workdir_identity";
  const { home, workdir, job } = await fixture(runId);
  const originalTarget = `${workdir}-original`;
  const replacementTarget = `${workdir}-replacement`;
  await rename(workdir, originalTarget);
  await mkdir(replacementTarget);
  await symlink(originalTarget, workdir, "dir");

  const claim = await claimCueLineCallerJob(runId, job.jobId, {
    home,
    callerId: "codex-workdir-owner",
  });
  assert.equal(claim.resolvedWorkdir, await realpath(originalTarget));

  await unlink(workdir);
  await symlink(replacementTarget, workdir, "dir");
  await assert.rejects(
    startCueLineCallerJob(runId, job.jobId, proof(claim), { home }),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "CALLER_WORKDIR_IDENTITY_MISMATCH",
  );

  const state = await loadCueLineRunState(runId, { home });
  assert.equal(state.jobs[job.jobId]?.status, "pending");
  assert.equal(state.jobs[job.jobId]?.callerWork?.claim?.startedAt, null);
  const events = await readEvents(runPaths(home, runId).events);
  assert.equal(events.some((entry) => entry.type === "caller_work_started"), false);
});

test("an unstarted legacy claim is upgraded to a directory-pinned claim", async () => {
  const runId = "run_caller_legacy_workdir_upgrade";
  const { home, workdir, job } = await fixture(runId);
  const timestamp = "2026-07-15T00:00:00.000Z";
  const now = () => new Date(timestamp);
  const legacyClaim = {
    claimId: "claim_33333333-3333-4333-8333-333333333333",
    callerId: "codex-legacy-owner",
    taskHash: jobSpecHash(job.spec),
    workdir,
    fencingToken: 1,
    claimedAt: timestamp,
    heartbeatAt: timestamp,
    expiresAt: "2026-07-15T00:05:00.000Z",
    ttlMs: 300_000,
    startedAt: null,
  };
  const lease = await RuntimeLease.claim({ home, runId, now });
  try {
    const store = await loadPersistedRunStore(home, runId);
    store.bindRuntimeOwner(lease.ownerId);
    await store.append("caller_work_claimed", {
      job_id: job.jobId,
      claim: legacyClaim,
    });
    await store.snapshot();
  } finally {
    await lease.release();
  }

  await assert.rejects(
    startCueLineCallerJob(
      runId,
      job.jobId,
      {
        claimId: legacyClaim.claimId,
        callerId: legacyClaim.callerId,
        fencingToken: legacyClaim.fencingToken,
      },
      { home, now },
    ),
    (error: unknown) =>
      error instanceof CueLineError && error.code === "CALLER_WORKDIR_IDENTITY_REQUIRED",
  );
  assert.equal(
    (await readEvents(runPaths(home, runId).events)).some(
      (entry) => entry.type === "caller_work_started",
    ),
    false,
  );

  const upgraded = await claimCueLineCallerJob(runId, job.jobId, {
    home,
    callerId: legacyClaim.callerId,
    now,
  });

  assert.equal(upgraded.outcome, "claimed");
  assert.notEqual(upgraded.claimId, legacyClaim.claimId);
  assert.equal(upgraded.fencingToken, 2);
  assert.equal(upgraded.resolvedWorkdir, await realpath(workdir));
  const state = await loadCueLineRunState(runId, { home });
  assert.equal(
    state.jobs[job.jobId]?.callerWork?.claim?.workdirIdentity?.resolvedPath,
    upgraded.resolvedWorkdir,
  );
  const events = await readEvents(runPaths(home, runId).events);
  assert.equal(events.filter((entry) => entry.type === "caller_work_claimed").length, 2);
  assert.equal(events.filter((entry) => entry.type === "caller_work_claim_released").length, 1);
});

test("caller work reducer rejects forged and out-of-order claim transitions", async () => {
  const { job, result } = await fixture("run_caller_claim_event_fencing");
  const timestamp = "2026-07-15T00:00:00.000Z";
  const validClaim = {
    claimId: "claim_11111111-1111-4111-8111-111111111111",
    callerId: "codex-event-owner",
    taskHash: jobSpecHash(job.spec),
    workdir: job.spec.workdir!,
    workdirIdentity: {
      resolvedPath: job.spec.workdir!,
      device: "1",
      inode: "2",
    },
    fencingToken: 1,
    claimedAt: timestamp,
    heartbeatAt: timestamp,
    expiresAt: "2026-07-15T00:05:00.000Z",
    ttlMs: 300_000,
    startedAt: null,
  };

  const wrongTask = reduceRunState(
    result.state,
    event("caller_work_claimed", {
      job_id: job.jobId,
      claim: { ...validClaim, taskHash: "0".repeat(64) },
    }),
  );
  assert.equal(wrongTask.jobs[job.jobId]?.callerWork?.claim, null);

  const claimed = reduceRunState(
    result.state,
    event("caller_work_claimed", { job_id: job.jobId, claim: validClaim }),
  );
  assert.equal(claimed.jobs[job.jobId]?.callerWork?.claim?.claimId, validClaim.claimId);

  const replaced = reduceRunState(
    claimed,
    event("caller_work_claimed", {
      job_id: job.jobId,
      claim: {
        ...validClaim,
        claimId: "claim_22222222-2222-4222-8222-222222222222",
        fencingToken: 2,
      },
    }),
  );
  assert.equal(replaced.jobs[job.jobId]?.callerWork?.claim?.claimId, validClaim.claimId);

  const forgedWorkdirStart = reduceRunState(
    claimed,
    event("caller_work_started", {
      job_id: job.jobId,
      claim_id: validClaim.claimId,
      caller_id: validClaim.callerId,
      fencing_token: validClaim.fencingToken,
      task_hash: validClaim.taskHash,
      workdir: validClaim.workdir,
      workdir_identity: { ...validClaim.workdirIdentity, inode: "3" },
      started_at: "2026-07-15T00:00:01.000Z",
      expires_at: "2026-07-15T00:05:01.000Z",
    }),
  );
  assert.equal(forgedWorkdirStart.jobs[job.jobId]?.status, "pending");

  const started = reduceRunState(
    claimed,
    event("caller_work_started", {
      job_id: job.jobId,
      claim_id: validClaim.claimId,
      caller_id: validClaim.callerId,
      fencing_token: validClaim.fencingToken,
      task_hash: validClaim.taskHash,
      workdir: validClaim.workdir,
      workdir_identity: validClaim.workdirIdentity,
      started_at: "2026-07-15T00:00:01.000Z",
      expires_at: "2026-07-15T00:05:01.000Z",
    }),
  );
  assert.equal(started.jobs[job.jobId]?.status, "running");

  const progressAHash = "a".repeat(64);
  const progressBHash = "b".repeat(64);
  const progressA = reduceRunState(
    started,
    event("caller_work_progress", {
      job_id: job.jobId,
      claim_id: validClaim.claimId,
      caller_id: validClaim.callerId,
      fencing_token: validClaim.fencingToken,
      progress_at: "2026-07-15T00:00:02.000Z",
      progress_kind: "tool_completed",
      progress_evidence_hash: progressAHash,
      expires_at: "2026-07-15T00:05:02.000Z",
    }),
  );
  const progressB = reduceRunState(
    progressA,
    event("caller_work_progress", {
      job_id: job.jobId,
      claim_id: validClaim.claimId,
      caller_id: validClaim.callerId,
      fencing_token: validClaim.fencingToken,
      progress_at: "2026-07-15T00:00:03.000Z",
      progress_kind: "verification_completed",
      progress_evidence_hash: progressBHash,
      expires_at: "2026-07-15T00:05:03.000Z",
    }),
  );
  const replayedProgressA = reduceRunState(
    progressB,
    event("caller_work_progress", {
      job_id: job.jobId,
      claim_id: validClaim.claimId,
      caller_id: validClaim.callerId,
      fencing_token: validClaim.fencingToken,
      progress_at: "2026-07-15T00:00:04.000Z",
      progress_kind: "tool_completed",
      progress_evidence_hash: progressAHash,
      expires_at: "2026-07-15T00:05:04.000Z",
    }),
  );
  assert.equal(
    replayedProgressA.jobs[job.jobId]?.callerWork?.claim?.lastProgressAt,
    "2026-07-15T00:00:03.000Z",
  );
  assert.deepEqual(
    replayedProgressA.jobs[job.jobId]?.callerWork?.claim?.progressEvidenceHashes,
    [progressAHash, progressBHash],
  );

  const releasedAfterStart = reduceRunState(
    started,
    event("caller_work_claim_released", {
      job_id: job.jobId,
      claim_id: validClaim.claimId,
      caller_id: validClaim.callerId,
      fencing_token: validClaim.fencingToken,
    }),
  );
  assert.equal(
    releasedAfterStart.jobs[job.jobId]?.callerWork?.claim?.claimId,
    validClaim.claimId,
  );

  const forgedAmbiguous = reduceRunState(
    started,
    event("caller_work_became_ambiguous", {
      job_id: job.jobId,
      claim_id: "claim_wrong",
      caller_id: validClaim.callerId,
      fencing_token: validClaim.fencingToken,
      reason: "forged",
    }),
  );
  assert.equal(forgedAmbiguous.jobs[job.jobId]?.status, "running");
});

test("an expired unstarted caller work claim is released and fenced before reclaim", async () => {
  const runId = "run_caller_claim_reclaim";
  const { home, job } = await fixture(runId);
  let current = new Date("2026-07-15T00:00:00.000Z");
  const now = () => current;
  const first = await claimCueLineCallerJob(runId, job.jobId, {
    home,
    callerId: "codex-before-crash",
    ttlMs: 1_000,
    now,
  });
  current = new Date("2026-07-15T00:00:01.001Z");
  const second = await claimCueLineCallerJob(runId, job.jobId, {
    home,
    callerId: "codex-after-restart",
    ttlMs: 1_000,
    now,
  });

  assert.notEqual(second.claimId, first.claimId);
  assert.ok(second.fencingToken > first.fencingToken);
  const state = await loadCueLineRunState(runId, { home });
  assert.equal(state.jobs[job.jobId]?.callerWork?.claim?.claimId, second.claimId);
  const types = (await readEvents(runPaths(home, runId).events)).map((event) => event.type);
  assert.equal(types.filter((type) => type === "caller_work_claimed").length, 2);
  assert.equal(types.filter((type) => type === "caller_work_claim_released").length, 1);
});

test("an expired claim after work started becomes ambiguous and cannot be reclaimed", async () => {
  const runId = "run_started_claim_expiry";
  const { home, job } = await fixture(runId);
  let current = new Date("2026-07-15T00:00:00.000Z");
  const now = () => current;
  const claim = await claimCueLineCallerJob(runId, job.jobId, {
    home,
    callerId: "codex-started",
    ttlMs: 1_000,
    now,
  });
  await startCueLineCallerJob(runId, job.jobId, proof(claim), { home, now });
  current = new Date("2026-07-15T00:00:01.001Z");

  await assert.rejects(
    claimCueLineCallerJob(runId, job.jobId, {
      home,
      callerId: "codex-takeover",
      ttlMs: 1_000,
      now,
    }),
    (error: unknown) =>
      error instanceof CueLineError && error.code === "CALLER_WORK_BECAME_AMBIGUOUS",
  );
  const state = await loadCueLineRunState(runId, { home });
  assert.equal(state.jobs[job.jobId]?.status, "ambiguous");
  const events = await readEvents(runPaths(home, runId).events);
  assert.equal(events.some((event) => event.type === "caller_work_became_ambiguous"), true);
});

test("continuing a caller run settles expired started work before asking Pro", async () => {
  const runId = "run_continue_settles_expired_started_work";
  const { home, job } = await fixture(runId);
  let current = new Date("2026-07-15T00:00:00.000Z");
  const now = () => current;
  const claim = await claimCueLineCallerJob(runId, job.jobId, {
    home,
    callerId: "codex-crashed-worker",
    ttlMs: 1_000,
    now,
  });
  await startCueLineCallerJob(runId, job.jobId, proof(claim), { home, now });
  current = new Date("2026-07-15T00:00:02.000Z");
  const browser = new FakeBrowserAdapter([
    reply((input) => {
      assert.match(input.prompt, /"status": "ambiguous"/);
      return {
        action: "complete",
        final_delivery_text: "Expired caller work was reported as ambiguous.",
      };
    }),
  ]);

  const completed = await continueCueLineRun({
    runId,
    home,
    now,
    browser,
    routingConfig: {
      version: 1,
      lanes: {
        default: {
          enabled: true,
          candidates: [
            {
              id: "must-not-spawn",
              argv: [process.execPath, "-e", "process.exit(99)"],
              task_input: "stdin",
            },
          ],
        },
      },
    },
  });

  assert.equal(completed.status, "complete");
  assert.equal(completed.state.jobs[job.jobId]?.status, "ambiguous");
  assert.equal(browser.calls.length, 1);
});

test("a durable work-result intent recovers a terminal status after the claim expires", async () => {
  const runId = "run_work_result_crash_recovery";
  const { home, job } = await fixture(runId);
  let current = new Date("2026-07-15T00:00:00.000Z");
  const now = () => current;
  const claim = await claimCueLineCallerJob(runId, job.jobId, {
    home,
    callerId: "codex-result-recovery",
    ttlMs: 1_000,
    now,
  });
  await startCueLineCallerJob(runId, job.jobId, proof(claim), { home, now });

  const lease = await RuntimeLease.claim({ home, runId, now });
  try {
    const store = await loadPersistedRunStore(home, runId);
    store.bindRuntimeOwner(lease.ownerId);
    await store.append("caller_work_result_submission_started", {
      job_id: job.jobId,
      claim_id: claim.claimId,
      caller_id: claim.callerId,
      fencing_token: claim.fencingToken,
      status: "succeeded",
    });
    await store.snapshot();
  } finally {
    await lease.release();
  }

  const startedAt = current.toISOString();
  const finishedAt = new Date(current.getTime() + 500).toISOString();
  await new JobStatusStore(home).write({
    jobId: job.jobId,
    runId,
    jobKey: job.jobKey,
    lane: job.spec.lane,
    mode: "work",
    execution: "foreground",
    status: "succeeded",
    startedAt,
    finishedAt,
    result: {
      status: "succeeded",
      exitCode: 0,
      stdout: "DURABLE_WORK_RESULT",
      stderr: "",
      output: "DURABLE_WORK_RESULT",
      emptyOutput: false,
      timedOut: false,
      cancelled: false,
      ambiguousSideEffects: false,
      retryable: false,
      startedAt,
      finishedAt,
    },
  });
  current = new Date("2026-07-15T00:00:02.000Z");

  const recovered = await submitCueLineCallerJobResult(
    runId,
    job.jobId,
    { status: "succeeded", stdout: "caller retry is ignored in favor of durable evidence" },
    { home, now, claim: proof(claim) },
  );

  assert.equal(recovered.outcome, "submitted");
  const state = await loadCueLineRunState(runId, { home });
  assert.equal(state.jobs[job.jobId]?.status, "succeeded");
  assert.equal(state.jobs[job.jobId]?.output, "DURABLE_WORK_RESULT");
  const events = await readEvents(runPaths(home, runId).events);
  assert.equal(events.some((entry) => entry.type === "caller_work_became_ambiguous"), false);
  assert.equal(
    events.filter((entry) => entry.type === "caller_work_result_submitted").length,
    1,
  );
});

test("caller work mutations reject a regressed clock before reporting success", async () => {
  const runId = "run_caller_claim_clock_regression";
  const { home, job } = await fixture(runId);
  let current = new Date("2026-07-15T00:00:01.000Z");
  const now = () => current;
  const claim = await claimCueLineCallerJob(runId, job.jobId, {
    home,
    callerId: "codex-clock-owner",
    ttlMs: 5_000,
    now,
  });
  current = new Date("2026-07-15T00:00:00.999Z");

  await assert.rejects(
    startCueLineCallerJob(runId, job.jobId, proof(claim), { home, now }),
    (error: unknown) =>
      error instanceof CueLineError && error.code === "CALLER_WORK_CLOCK_REGRESSION",
  );
  const state = await loadCueLineRunState(runId, { home });
  assert.equal(state.jobs[job.jobId]?.status, "pending");
  assert.equal(state.jobs[job.jobId]?.callerWork?.claim?.startedAt, null);
});

test("caller results reject invalid or reversed timestamps before durable mutation", async () => {
  const runId = "run_caller_result_timestamp_validation";
  const { home, job } = await fixture(runId);
  const claim = await claimCueLineCallerJob(runId, job.jobId, {
    home,
    callerId: "codex-timestamp-owner",
  });
  await startCueLineCallerJob(runId, job.jobId, proof(claim), { home });

  for (const input of [
    {
      status: "succeeded" as const,
      startedAt: "not-an-iso-time",
      finishedAt: "2026-07-15T00:00:02.000Z",
    },
    {
      status: "succeeded" as const,
      startedAt: "2026-07-15T00:00:02.000Z",
      finishedAt: "2026-07-15T00:00:01.000Z",
    },
  ]) {
    await assert.rejects(
      submitCueLineCallerJobResult(runId, job.jobId, input, {
        home,
        claim: proof(claim),
      }),
      (error: unknown) =>
        error instanceof CueLineError && error.code === "CALLER_JOB_RESULT_INVALID",
    );
  }
  const state = await loadCueLineRunState(runId, { home });
  assert.equal(state.jobs[job.jobId]?.status, "running");
});

test("caller result default timestamps are validated before durable submission intent", async () => {
  const runId = "run_caller_result_default_timestamp_preflight";
  const { home, job } = await fixture(runId);
  const current = new Date("2026-07-15T00:00:00.000Z");
  const now = () => current;
  const claim = await claimCueLineCallerJob(runId, job.jobId, {
    home,
    callerId: "codex-default-timestamp-owner",
    now,
  });
  await startCueLineCallerJob(runId, job.jobId, proof(claim), { home, now });
  const before = await readEvents(runPaths(home, runId).events);

  for (const timestamps of [
    { startedAt: "2026-07-15T00:00:01.000Z" },
    { finishedAt: "2026-07-14T23:59:59.999Z" },
  ]) {
    await assert.rejects(
      submitCueLineCallerJobResult(
        runId,
        job.jobId,
        {
          status: "succeeded",
          stdout: "must not create a half-written submission",
          ...timestamps,
        },
        { home, claim: proof(claim), now },
      ),
      (error: unknown) =>
        error instanceof CueLineError && error.code === "CALLER_JOB_RESULT_INVALID",
    );
  }

  const after = await readEvents(runPaths(home, runId).events);
  assert.deepEqual(after, before);
  assert.equal(
    after.some((entry) => entry.type === "caller_work_result_submission_started"),
    false,
  );
  assert.equal((await loadCueLineRunState(runId, { home })).jobs[job.jobId]?.status, "running");
  assert.equal((await new JobStatusStore(home).read(job.jobId))?.status, "running");
});

test("successful caller output stays complete in job status but bounded in run events", async () => {
  const runId = "run_caller_success_event_output_bound";
  const { home, job } = await fixture(runId, 4_000);
  const claim = await claimCueLineCallerJob(runId, job.jobId, {
    home,
    callerId: "codex-large-success-owner",
  });
  await startCueLineCallerJob(runId, job.jobId, proof(claim), { home });
  const stdout = `CALLER_STDOUT_SUMMARY\n${"S".repeat(30_000)}`;
  const stderr = `CALLER_STDERR_TRACE_SENTINEL\n${"T".repeat(150_000)}`;

  await submitCueLineCallerJobResult(
    runId,
    job.jobId,
    { status: "succeeded", stdout, stderr },
    { home, claim: proof(claim) },
  );

  const persisted = await new JobStatusStore(home).read(job.jobId);
  assert.equal(persisted?.result?.stdout, stdout);
  assert.equal(persisted?.result?.stderr, stderr);
  const terminalEvent = (await readEvents(runPaths(home, runId).events)).findLast(
    (entry) =>
      entry.type === "job_status" &&
      typeof entry.payload === "object" &&
      entry.payload !== null &&
      !Array.isArray(entry.payload) &&
      (entry.payload as Record<string, unknown>).status === "succeeded",
  );
  const payload = terminalEvent?.payload as Record<string, unknown>;
  assert.equal(typeof payload.output, "string");
  assert.match(payload.output as string, /CALLER_STDOUT_SUMMARY/);
  assert.match(payload.output as string, /\[job evidence capped: \d+ chars omitted;.*cap=4000\]$/);
  assert.equal(payload.output_total_chars, stdout.length);
  assert.doesNotMatch(payload.output as string, /CALLER_STDERR_TRACE_SENTINEL/);
  assert.ok((payload.output as string).length < 4_200);
});

test("failed caller output and error stay complete in job status but bounded in run events", async () => {
  const runId = "run_caller_failure_event_output_bound";
  const { home, job } = await fixture(runId);
  const claim = await claimCueLineCallerJob(runId, job.jobId, {
    home,
    callerId: "codex-large-failure-owner",
  });
  await startCueLineCallerJob(runId, job.jobId, proof(claim), { home });
  const stdout = `PARTIAL_WORK\n${"P".repeat(30_000)}`;
  const stderr = `FAILURE_TRACE\n${"F".repeat(150_000)}`;
  const error = `FAILURE_REASON\n${"E".repeat(40_000)}`;

  await submitCueLineCallerJobResult(
    runId,
    job.jobId,
    { status: "failed", stdout, stderr, error, exitCode: 1 },
    { home, claim: proof(claim) },
  );

  const persisted = await new JobStatusStore(home).read(job.jobId);
  assert.equal(persisted?.result?.stdout, stdout);
  assert.equal(persisted?.result?.stderr, stderr);
  assert.equal(persisted?.error, error);
  const terminalEvent = (await readEvents(runPaths(home, runId).events)).findLast(
    (entry) =>
      entry.type === "job_status" &&
      typeof entry.payload === "object" &&
      entry.payload !== null &&
      !Array.isArray(entry.payload) &&
      (entry.payload as Record<string, unknown>).status === "ambiguous",
  );
  const payload = terminalEvent?.payload as Record<string, unknown>;
  assert.equal(typeof payload.output, "string");
  assert.equal(typeof payload.error, "string");
  assert.match(payload.output as string, /\[job evidence capped: \d+ chars omitted;/);
  assert.match(payload.error as string, /\[job evidence capped: \d+ chars omitted;/);
  assert.equal(payload.output_total_chars, `${stdout}\n${stderr}`.length);
  assert.equal(payload.error_total_chars, error.length);
  assert.ok((payload.output as string).length < 20_000);
  assert.ok((payload.error as string).length < 20_000);
});

test("a non-success result after caller work starts is terminally ambiguous", async () => {
  const runId = "run_caller_failed_work_is_ambiguous";
  const { home, job } = await fixture(runId);
  const claim = await claimCueLineCallerJob(runId, job.jobId, {
    home,
    callerId: "codex-failed-work-owner",
  });
  await startCueLineCallerJob(runId, job.jobId, proof(claim), { home });

  const submitted = await submitCueLineCallerJobResult(
    runId,
    job.jobId,
    {
      status: "failed",
      stdout: "partial local mutation may exist",
      stderr: "worker exited before verification",
      exitCode: 1,
    },
    { home, claim: proof(claim) },
  );

  assert.equal(submitted.outcome, "submitted");
  const state = await loadCueLineRunState(runId, { home });
  assert.equal(state.jobs[job.jobId]?.status, "ambiguous");
  const persisted = await new JobStatusStore(home).read(job.jobId);
  assert.equal(persisted?.status, "ambiguous");
  assert.equal(persisted?.result?.status, "ambiguous");
  assert.equal(persisted?.result?.ambiguousSideEffects, true);
  assert.match(persisted?.result?.output ?? "", /partial local mutation may exist/);
});

test("caller work proof is fenced across start heartbeat release and terminal result", async () => {
  const runId = "run_caller_claim_proof";
  const { home, job } = await fixture(runId);
  const pendingStatus = await loadCueLineRunStatus(runId, { home });
  assert.equal(pendingStatus.phase, "caller_work_pending");
  assert.equal(pendingStatus.safeNextAction, "claim_caller_work");
  assert.equal(pendingStatus.jobs.items[0]?.workClaim?.claimed, false);
  const claim = await claimCueLineCallerJob(runId, job.jobId, {
    home,
    callerId: "codex-proof-owner",
  });
  const claimedStatus = await loadCueLineRunStatus(runId, { home });
  assert.equal(claimedStatus.phase, "caller_work_claimed");
  assert.equal(claimedStatus.safeNextAction, "start_caller_work");
  assert.equal(claimedStatus.jobs.items[0]?.workClaim?.callerId, claim.callerId);
  const invalid = { ...proof(claim), fencingToken: claim.fencingToken + 1 };
  await assert.rejects(
    startCueLineCallerJob(runId, job.jobId, invalid, { home }),
    (error: unknown) =>
      error instanceof CueLineError && error.code === "CALLER_WORK_CLAIM_MISMATCH",
  );
  await assert.rejects(
    submitCueLineCallerJobResult(
      runId,
      job.jobId,
      { status: "succeeded", stdout: "must not commit" },
      { home, claim: invalid },
    ),
    (error: unknown) =>
      error instanceof CueLineError && error.code === "CALLER_WORK_CLAIM_MISMATCH",
  );

  const started = await startCueLineCallerJob(runId, job.jobId, proof(claim), { home });
  assert.equal(started.outcome, "started");
  const runningStatus = await loadCueLineRunStatus(runId, { home });
  assert.equal(runningStatus.phase, "caller_work_running");
  assert.equal(runningStatus.safeNextAction, "continue_caller_work");
  const heartbeat = await heartbeatCueLineCallerJob(runId, job.jobId, proof(claim), { home });
  assert.equal(heartbeat.outcome, "heartbeat_recorded");
  await assert.rejects(
    releaseCueLineCallerJob(runId, job.jobId, proof(claim), { home }),
    (error: unknown) =>
      error instanceof CueLineError && error.code === "CALLER_WORK_RELEASE_AFTER_START_FORBIDDEN",
  );

  const submitted = await submitCueLineCallerJobResult(
    runId,
    job.jobId,
    { status: "succeeded", stdout: "CALLER_WORK_OK" },
    { home, claim: proof(claim) },
  );
  assert.equal(submitted.outcome, "submitted");
  const duplicate = await submitCueLineCallerJobResult(
    runId,
    job.jobId,
    { status: "failed", stderr: "must be ignored" },
    { home, claim: proof(claim) },
  );
  assert.equal(duplicate.outcome, "already_terminal");
  const events = await readEvents(runPaths(home, runId).events);
  assert.equal(
    events.filter((event) => event.type === "caller_work_result_submitted").length,
    1,
  );
});

test("caller work records only new durable progress evidence", async () => {
  const runId = "run_caller_progress_checkpoint";
  const { home, job } = await fixture(runId);
  let current = new Date("2026-07-22T00:00:00.000Z");
  const now = () => current;
  const claim = await claimCueLineCallerJob(runId, job.jobId, {
    home,
    callerId: "codex-progress-owner",
    now,
  });
  await startCueLineCallerJob(runId, job.jobId, proof(claim), { home, now });

  current = new Date("2026-07-22T00:01:00.000Z");
  const evidenceHash = "a".repeat(64);
  const recorded = await recordCueLineCallerJobProgress(
    runId,
    job.jobId,
    proof(claim),
    { kind: "tool_completed", evidenceHash },
    { home, now },
  );
  assert.equal(recorded.outcome, "progress_recorded");
  assert.equal(recorded.progressAt, current.toISOString());
  assert.equal(recorded.progressKind, "tool_completed");
  assert.equal(recorded.progressEvidenceHash, evidenceHash);

  current = new Date("2026-07-22T00:02:00.000Z");
  const duplicate = await recordCueLineCallerJobProgress(
    runId,
    job.jobId,
    proof(claim),
    { kind: "verification_completed", evidenceHash },
    { home, now },
  );
  assert.equal(duplicate.outcome, "progress_already_recorded");
  assert.equal(duplicate.progressAt, recorded.progressAt);
  assert.equal(duplicate.heartbeatAt, recorded.heartbeatAt);

  current = new Date("2026-07-22T00:03:00.000Z");
  const newerHash = "b".repeat(64);
  const newer = await recordCueLineCallerJobProgress(
    runId,
    job.jobId,
    proof(claim),
    { kind: "verification_completed", evidenceHash: newerHash },
    { home, now },
  );
  assert.equal(newer.outcome, "progress_recorded");

  current = new Date("2026-07-22T00:04:00.000Z");
  const replayedOlder = await recordCueLineCallerJobProgress(
    runId,
    job.jobId,
    proof(claim),
    { kind: "tool_completed", evidenceHash },
    { home, now },
  );
  assert.equal(replayedOlder.outcome, "progress_already_recorded");
  assert.equal(replayedOlder.progressAt, recorded.progressAt);

  await heartbeatCueLineCallerJob(runId, job.jobId, proof(claim), { home, now });
  const state = await loadCueLineRunState(runId, { home });
  assert.equal(
    state.jobs[job.jobId]?.callerWork?.claim?.lastProgressAt,
    newer.progressAt,
  );
  assert.equal(
    state.jobs[job.jobId]?.callerWork?.claim?.lastProgressEvidenceHash,
    newerHash,
  );
  assert.deepEqual(
    state.jobs[job.jobId]?.callerWork?.claim?.progressEvidenceHashes,
    [evidenceHash, newerHash],
  );
  const status = await new JobStatusStore(home).read(job.jobId);
  assert.equal(status?.lastProgressAt, newer.progressAt);
  assert.equal(status?.phase, "verification_completed");
  const events = await readEvents(runPaths(home, runId).events);
  assert.equal(events.filter((entry) => entry.type === "caller_work_progress").length, 2);
});

test("caller work rejects invalid progress evidence without durable mutation", async () => {
  const runId = "run_caller_progress_invalid";
  const { home, job } = await fixture(runId);
  const claim = await claimCueLineCallerJob(runId, job.jobId, {
    home,
    callerId: "codex-progress-invalid-owner",
  });
  await startCueLineCallerJob(runId, job.jobId, proof(claim), { home });

  await assert.rejects(
    recordCueLineCallerJobProgress(
      runId,
      job.jobId,
      proof(claim),
      { kind: "tool_completed", evidenceHash: "not-a-sha256" },
      { home },
    ),
    (error: unknown) =>
      error instanceof CueLineError && error.code === "CALLER_WORK_PROGRESS_INVALID",
  );
  const events = await readEvents(runPaths(home, runId).events);
  assert.equal(events.filter((entry) => entry.type === "caller_work_progress").length, 0);
});

test("caller work lease defaults separate liveness, progress review, and hard stop", () => {
  assert.equal(DEFAULT_CALLER_WORK_HEARTBEAT_INTERVAL_MS, 60_000);
  assert.equal(DEFAULT_CALLER_WORK_PROGRESS_TIMEOUT_MS, 3_600_000);
  assert.equal(DEFAULT_CALLER_WORK_MAX_EXECUTION_MS, 86_400_000);
});

test("restarting an active lease cannot reset its durable progress deadline", async () => {
  const runId = "run_caller_executor_progress_restart";
  const { home, job } = await fixture(runId);
  let current = new Date("2026-07-22T00:00:00.000Z");
  const now = () => current;
  const claim = await claimCueLineCallerJob(runId, job.jobId, {
    home,
    callerId: "codex-progress-restart-owner",
    ttlMs: 5_000,
    now,
  });
  const firstLease = await startCueLineCallerWorkLease(claim, {
    home,
    now,
    heartbeatIntervalMs: 1_000,
    progressTimeoutMs: 1_000,
    maxExecutionMs: 5_000,
  });
  await firstLease.stop();

  current = new Date("2026-07-22T00:00:01.100Z");
  const recovered = await claimCueLineCallerJob(runId, job.jobId, {
    home,
    callerId: claim.callerId,
    now,
  });
  assert.equal(recovered.startedAt, "2026-07-22T00:00:00.000Z");
  assert.equal(recovered.lastProgressAt, "2026-07-22T00:00:00.000Z");
  await assert.rejects(
    startCueLineCallerWorkLease(recovered, {
      home,
      now,
      heartbeatIntervalMs: 1_000,
      progressTimeoutMs: 1_000,
      maxExecutionMs: 5_000,
    }),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "CALLER_WORK_PROGRESS_REVIEW_REQUIRED",
  );
  const state = await loadCueLineRunState(runId, { home });
  assert.equal(state.jobs[job.jobId]?.status, "ambiguous");
  const events = await readEvents(runPaths(home, runId).events);
  assert.equal(
    events.filter((entry) => entry.type === "caller_work_heartbeat").length,
    0,
  );
});

test("restarting an active lease cannot reset its durable absolute deadline", async () => {
  const runId = "run_caller_executor_max_restart";
  const { home, job } = await fixture(runId);
  let current = new Date("2026-07-22T00:00:00.000Z");
  const now = () => current;
  const claim = await claimCueLineCallerJob(runId, job.jobId, {
    home,
    callerId: "codex-max-restart-owner",
    ttlMs: 5_000,
    now,
  });
  const firstLease = await startCueLineCallerWorkLease(claim, {
    home,
    now,
    heartbeatIntervalMs: 1_000,
    progressTimeoutMs: 5_000,
    maxExecutionMs: 1_000,
  });
  await firstLease.stop();

  current = new Date("2026-07-22T00:00:01.100Z");
  await assert.rejects(
    startCueLineCallerWorkLease(claim, {
      home,
      now,
      heartbeatIntervalMs: 1_000,
      progressTimeoutMs: 5_000,
      maxExecutionMs: 1_000,
    }),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "CALLER_WORK_MAX_EXECUTION_EXCEEDED",
  );
  const state = await loadCueLineRunState(runId, { home });
  assert.equal(state.jobs[job.jobId]?.status, "ambiguous");
  const events = await readEvents(runPaths(home, runId).events);
  assert.equal(
    events.filter((entry) => entry.type === "caller_work_heartbeat").length,
    0,
  );
});

test("executor-owned caller work lease heartbeats automatically and stops cleanly", async () => {
  const runId = "run_caller_executor_lease";
  const { home, job } = await fixture(runId);
  let observedMs = Date.parse("2026-07-22T00:00:00.000Z");
  const now = () => {
    observedMs += 1_000;
    return new Date(observedMs);
  };
  const claim = await claimCueLineCallerJob(runId, job.jobId, {
    home,
    callerId: "codex-executor-lease-owner",
    ttlMs: 60_000,
    now,
  });
  const lease = await startCueLineCallerWorkLease(claim, {
    home,
    now,
    heartbeatIntervalMs: 10,
    progressTimeoutMs: 1_000,
    maxExecutionMs: 2_000,
  });

  const deadline = Date.now() + 1_000;
  let heartbeatCount = 0;
  while (Date.now() < deadline) {
    const events = await readEvents(runPaths(home, runId).events);
    heartbeatCount = events.filter((entry) => entry.type === "caller_work_heartbeat").length;
    if (heartbeatCount >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(heartbeatCount >= 2, "expected the executor lease to renew automatically");
  assert.equal(lease.signal.aborted, false);
  lease.assertHealthy();

  await lease.stop();
  const stoppedCount = (await readEvents(runPaths(home, runId).events)).filter(
    (entry) => entry.type === "caller_work_heartbeat",
  ).length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  const finalCount = (await readEvents(runPaths(home, runId).events)).filter(
    (entry) => entry.type === "caller_work_heartbeat",
  ).length;
  assert.equal(finalCount, stoppedCount);
});

test("executor-owned caller work lease stops at its hard execution limit", async () => {
  const runId = "run_caller_executor_lease_limit";
  const { home, job } = await fixture(runId);
  const claim = await claimCueLineCallerJob(runId, job.jobId, {
    home,
    callerId: "codex-executor-lease-limit-owner",
  });
  const lease = await startCueLineCallerWorkLease(claim, {
    home,
    heartbeatIntervalMs: 10,
    progressTimeoutMs: 1_000,
    maxExecutionMs: 40,
  });

  await new Promise<void>((resolve) => {
    if (lease.signal.aborted) resolve();
    else lease.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  assert.equal(lease.signal.aborted, true);
  assert.throws(
    () => lease.assertHealthy(),
    (error: unknown) =>
      error instanceof CueLineError && error.code === "CALLER_WORK_MAX_EXECUTION_EXCEEDED",
  );
  const hardLimitState = await loadCueLineRunState(runId, { home });
  assert.equal(hardLimitState.jobs[job.jobId]?.status, "ambiguous");
  const hardLimitEvents = await readEvents(runPaths(home, runId).events);
  assert.equal(
    hardLimitEvents.some(
      (entry) =>
        entry.type === "caller_work_review_required" &&
        (entry.payload as Record<string, unknown>).reason_code ===
          "max_execution_elapsed",
    ),
    true,
  );
  const heartbeatCountAtAbort = (await readEvents(runPaths(home, runId).events)).filter(
    (entry) => entry.type === "caller_work_heartbeat",
  ).length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  const heartbeatCountAfterAbort = (await readEvents(runPaths(home, runId).events)).filter(
    (entry) => entry.type === "caller_work_heartbeat",
  ).length;
  assert.equal(heartbeatCountAfterAbort, heartbeatCountAtAbort);
  await lease.stop();
});

test("executor-owned heartbeats do not count as work progress", async () => {
  const runId = "run_caller_executor_progress_review";
  const { home, job } = await fixture(runId);
  const claim = await claimCueLineCallerJob(runId, job.jobId, {
    home,
    callerId: "codex-executor-progress-review-owner",
    ttlMs: 1_000,
  });
  const lease = await startCueLineCallerWorkLease(claim, {
    home,
    heartbeatIntervalMs: 10,
    progressTimeoutMs: 60,
    maxExecutionMs: 1_000,
  });

  await new Promise<void>((resolve) => {
    if (lease.signal.aborted) resolve();
    else lease.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  assert.throws(
    () => lease.assertHealthy(),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "CALLER_WORK_PROGRESS_REVIEW_REQUIRED",
  );
  const events = await readEvents(runPaths(home, runId).events);
  assert.ok(events.some((entry) => entry.type === "caller_work_heartbeat"));
  assert.equal(events.some((entry) => entry.type === "caller_work_progress"), false);
  assert.equal(
    events.some(
      (entry) =>
        entry.type === "caller_work_review_required" &&
        (entry.payload as Record<string, unknown>).reason_code === "progress_stalled",
    ),
    true,
  );
  const state = await loadCueLineRunState(runId, { home });
  assert.equal(state.jobs[job.jobId]?.status, "ambiguous");
  await lease.stop();
});

test("new executor progress resets review timing but duplicate evidence does not", async () => {
  const runId = "run_caller_executor_progress_reset";
  const { home, job } = await fixture(runId);
  const claim = await claimCueLineCallerJob(runId, job.jobId, {
    home,
    callerId: "codex-executor-progress-reset-owner",
    ttlMs: 1_000,
  });
  const lease = await startCueLineCallerWorkLease(claim, {
    home,
    heartbeatIntervalMs: 20,
    progressTimeoutMs: 300,
    maxExecutionMs: 2_000,
  });
  const evidenceHash = "b".repeat(64);

  await new Promise((resolve) => setTimeout(resolve, 100));
  const recorded = await lease.recordProgress({
    kind: "checkpoint_persisted",
    evidenceHash,
  });
  assert.equal(recorded.outcome, "progress_recorded");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(lease.signal.aborted, false);
  const duplicate = await lease.recordProgress({
    kind: "checkpoint_persisted",
    evidenceHash,
  });
  assert.equal(duplicate.outcome, "progress_already_recorded");

  await new Promise<void>((resolve) => {
    if (lease.signal.aborted) resolve();
    else lease.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  assert.throws(
    () => lease.assertHealthy(),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "CALLER_WORK_PROGRESS_REVIEW_REQUIRED",
  );
  const events = await readEvents(runPaths(home, runId).events);
  assert.equal(events.filter((entry) => entry.type === "caller_work_progress").length, 1);
  await lease.stop();
});

test("executor-owned lease stays active through terminal submission after the initial TTL", async () => {
  const runId = "run_caller_executor_lease_submit";
  const { home, job } = await fixture(runId);
  const claim = await claimCueLineCallerJob(runId, job.jobId, {
    home,
    callerId: "codex-executor-lease-submit-owner",
    ttlMs: 1_000,
  });
  const lease = await startCueLineCallerWorkLease(claim, {
    home,
    heartbeatIntervalMs: 100,
    progressTimeoutMs: 5_000,
    maxExecutionMs: 5_000,
  });

  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await lease.heartbeatNow();
  lease.assertHealthy();
  let submitted;
  try {
    submitted = await submitCueLineCallerJobResult(
      runId,
      job.jobId,
      { status: "succeeded", stdout: "LEASE_SUBMISSION_OK" },
      { home, claim: proof(claim) },
    );
  } finally {
    await lease.stop();
  }
  assert.equal(submitted.outcome, "submitted");
});

test("executor-owned caller work lease rejects an unsafe heartbeat cadence before start", async () => {
  const runId = "run_caller_executor_lease_invalid_cadence";
  const { home, job } = await fixture(runId);
  const claim = await claimCueLineCallerJob(runId, job.jobId, {
    home,
    callerId: "codex-executor-lease-invalid-cadence",
    ttlMs: 1_000,
  });

  await assert.rejects(
    startCueLineCallerWorkLease(claim, {
      home,
      heartbeatIntervalMs: 1_000,
      maxExecutionMs: 10_000,
    }),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "CALLER_WORK_HEARTBEAT_INTERVAL_INVALID",
  );
  const status = await loadCueLineRunStatus(runId, { home });
  assert.equal(status.phase, "caller_work_claimed");
  assert.equal(status.safeNextAction, "start_caller_work");
});
