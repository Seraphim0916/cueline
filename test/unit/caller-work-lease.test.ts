import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { claimCueLineCallerJob, startCueLineCallerJob } from "../../src/api-caller-work.js";
import {
  startCueLineCallerWorkLease,
  type CueLineCallerWorkLease,
} from "../../src/api-caller-work-lease.js";
import type { CueLineCallerWorkClaimResult } from "../../src/api-contracts.js";
import { cancelCueLineJob, loadCueLineRunState } from "../../src/api-runtime-lifecycle.js";
import { runCueLine } from "../../src/api.js";
import type { BrowserTurnInput, ControllerTurn } from "../../src/browser/browser-adapter.js";
import { CueLineError } from "../../src/core/errors.js";
import { readEvents } from "../../src/state/event-log.js";
import { runPaths } from "../../src/state/paths.js";
import { FakeBrowserAdapter } from "../fakes/fake-browser.js";

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof CueLineError && error.code === code;
}

function syntheticClaim(overrides: Partial<CueLineCallerWorkClaimResult> = {}): CueLineCallerWorkClaimResult {
  return {
    runId: "run_lease_synthetic",
    jobId: "job_lease_synthetic",
    claimId: "claim_synthetic",
    callerId: "caller",
    fencingToken: 1,
    outcome: "claimed",
    task: "task",
    taskHash: "hash",
    workdir: "/nonexistent",
    resolvedWorkdir: "/nonexistent",
    claimedAt: "2026-10-26T00:00:00.000Z",
    heartbeatAt: "2026-10-26T00:00:00.000Z",
    expiresAt: "2026-10-26T00:05:00.000Z",
    started: false,
    startedAt: null,
    ...overrides,
  };
}

function dispatchWork(workdir: string): (input: BrowserTurnInput) => ControllerTurn {
  return (input) => ({
    text: `<CueLineControl>${JSON.stringify({
      protocol: "cueline/0.1",
      run_id: input.runId,
      round: input.round,
      request_id: input.requestId,
      action: "dispatch",
      jobs: [{ job_key: "local_work", lane: "default", mode: "work", task: "edit", workdir }],
    })}</CueLineControl>`,
    conversationUrl: "https://chatgpt.com/c/caller-work-lease-unit",
    model: {
      provider: "chatgpt",
      selectedLabel: "Pro",
      responseModelSlug: "gpt-5-6-pro",
      source: "composer_and_response",
    },
  });
}

async function claimedWork(runId: string, ttlMs = 60_000, now?: () => Date) {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-unit-lease-"));
  const workdir = path.join(home, "workspace");
  await mkdir(workdir);
  const result = await runCueLine({
    request: "caller work lease unit test",
    runId,
    home,
    browser: new FakeBrowserAdapter([dispatchWork(workdir)]),
    routingConfig: {
      version: 1,
      lanes: {
        default: {
          enabled: true,
          candidates: [{ id: "must-not-spawn", argv: [process.execPath, "-e", "process.exit(99)"], task_input: "stdin" }],
        },
      },
    },
  });
  assert.equal(result.status, "awaiting_caller_work");
  const job = Object.values(result.state.jobs)[0]!;
  const claim = await claimCueLineCallerJob(runId, job.jobId, {
    home,
    callerId: `owner-${runId}`,
    ttlMs,
    ...(now === undefined ? {} : { now }),
  });
  return { home, job, claim };
}

// Validation must fail before any I/O; an isolated home keeps a regression off ~/.cueline.
async function isolated(): Promise<{ home: string; environment: NodeJS.ProcessEnv }> {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-unit-lease-isolated-"));
  return { home, environment: { CUELINE_HOME: home } };
}

async function waitForAbort(signal: AbortSignal, timeoutMs = 2_000): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`no abort within ${timeoutMs}ms`)), timeoutMs);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

async function eventCount(home: string, runId: string, type: string): Promise<number> {
  return (await readEvents(runPaths(home, runId).events)).filter((event) => event.type === type).length;
}

test("an already aborted executor scope is rejected before any durable mutation", async () => {
  const controller = new AbortController();
  const reason = new Error("executor shutting down");
  controller.abort(reason);
  await assert.rejects(
    startCueLineCallerWorkLease(syntheticClaim(), { ...(await isolated()), signal: controller.signal }),
    (error: unknown) =>
      hasCode("CALLER_WORK_EXECUTION_ABORTED")(error) && (error as Error).cause === reason,
  );
});

test("each timer option is validated with its own error code", async () => {
  const cases: Array<[string, Record<string, number>, string]> = [
    ["heartbeat zero", { heartbeatIntervalMs: 0 }, "CALLER_WORK_HEARTBEAT_INTERVAL_INVALID"],
    ["heartbeat fractional", { heartbeatIntervalMs: 1.5 }, "CALLER_WORK_HEARTBEAT_INTERVAL_INVALID"],
    ["max execution negative", { maxExecutionMs: -1 }, "CALLER_WORK_MAX_EXECUTION_INVALID"],
    ["max execution beyond Node timers", { maxExecutionMs: 2 ** 31 }, "CALLER_WORK_MAX_EXECUTION_INVALID"],
    ["progress NaN", { progressTimeoutMs: Number.NaN }, "CALLER_WORK_PROGRESS_TIMEOUT_INVALID"],
  ];
  for (const [label, timerOptions, code] of cases) {
    await assert.rejects(
      startCueLineCallerWorkLease(syntheticClaim(), { ...(await isolated()), ...timerOptions }),
      hasCode(code),
      label,
    );
  }
});

test("the heartbeat cadence must fit strictly inside a well-formed claim window", async () => {
  const cases: Array<[string, Partial<CueLineCallerWorkClaimResult>, number]> = [
    ["equal to window", { expiresAt: "2026-10-26T00:00:01.000Z" }, 1_000],
    ["longer than window", { expiresAt: "2026-10-26T00:00:01.000Z" }, 1_001],
    ["empty window", { expiresAt: "2026-10-26T00:00:00.000Z" }, 1],
    ["inverted window", { expiresAt: "2026-10-25T23:59:59.000Z" }, 1],
    ["unparseable heartbeat", { heartbeatAt: "not a time" }, 1],
    ["unparseable expiry", { expiresAt: "not a time" }, 1],
  ];
  for (const [label, claim, heartbeatIntervalMs] of cases) {
    await assert.rejects(
      startCueLineCallerWorkLease(syntheticClaim(claim), { ...(await isolated()), heartbeatIntervalMs }),
      (error: unknown) =>
        hasCode("CALLER_WORK_HEARTBEAT_INTERVAL_INVALID")(error) &&
        (error as CueLineError & { details: { heartbeat_interval_ms: number } }).details
          .heartbeat_interval_ms === heartbeatIntervalMs,
      label,
    );
  }
});

test("an active lease exposes its proof and limits, records progress, and rejects mutations after stop", async () => {
  const runId = "run_unit_lease_active";
  const { home, job, claim } = await claimedWork(runId);
  const lease = await startCueLineCallerWorkLease(claim, {
    home,
    heartbeatIntervalMs: 10_000,
    progressTimeoutMs: 60_000,
    maxExecutionMs: 120_000,
  });
  try {
    assert.equal(lease.runId, runId);
    assert.equal(lease.jobId, job.jobId);
    assert.deepEqual(lease.proof, {
      claimId: claim.claimId,
      callerId: claim.callerId,
      fencingToken: claim.fencingToken,
    });
    assert.equal(lease.heartbeatIntervalMs, 10_000);
    assert.equal(lease.progressTimeoutMs, 60_000);
    assert.equal(lease.maxExecutionMs, 120_000);
    assert.equal(lease.active, true);
    assert.equal(lease.failure, undefined);
    lease.assertHealthy();

    const heartbeat = await lease.heartbeatNow();
    assert.equal(heartbeat.outcome, "heartbeat_recorded");
    const progress = await lease.recordProgress({ kind: "tool_completed", evidenceHash: "c".repeat(64) });
    assert.equal(progress.outcome, "progress_recorded");
    const repeated = await lease.recordProgress({ kind: "tool_completed", evidenceHash: "c".repeat(64) });
    assert.equal(repeated.outcome, "progress_already_recorded");
    assert.equal(lease.active, true);
  } finally {
    await lease.stop();
  }
  assert.equal(lease.active, false);
  assert.equal(lease.signal.aborted, false);
  await assert.rejects(lease.heartbeatNow(), hasCode("CALLER_WORK_LEASE_NOT_ACTIVE"));
  await assert.rejects(
    lease.recordProgress({ kind: "tool_completed", evidenceHash: "d".repeat(64) }),
    hasCode("CALLER_WORK_LEASE_NOT_ACTIVE"),
  );
  // stop is idempotent.
  await lease.stop();
  assert.equal(lease.signal.aborted, false);
});

test("restarting an already started job renews its claim instead of starting again", async () => {
  const runId = "run_unit_lease_restart";
  const { home, job, claim } = await claimedWork(runId);
  await startCueLineCallerJob(runId, job.jobId, claim, { home });
  const heartbeatsBefore = await eventCount(home, runId, "caller_work_heartbeat");
  const lease = await startCueLineCallerWorkLease(claim, { home, heartbeatIntervalMs: 10_000 });
  try {
    assert.equal(lease.active, true);
    assert.equal(await eventCount(home, runId, "caller_work_started"), 1);
    assert.equal(await eventCount(home, runId, "caller_work_heartbeat"), heartbeatsBefore + 1);
  } finally {
    await lease.stop();
  }
});

test("aborting the executor scope fails the lease with the caller's reason", async () => {
  const runId = "run_unit_lease_abort";
  const { home, claim } = await claimedWork(runId);
  const controller = new AbortController();
  const lease = await startCueLineCallerWorkLease(claim, {
    home,
    signal: controller.signal,
    heartbeatIntervalMs: 10_000,
  });
  const reason = new CueLineError("EXECUTOR_GONE", "executor was cancelled");
  controller.abort(reason);
  await waitForAbort(lease.signal);

  assert.equal(lease.active, false);
  assert.equal(lease.failure, reason);
  assert.equal(lease.signal.reason, reason);
  assert.throws(() => lease.assertHealthy(), (error: unknown) => error === reason);
  await assert.rejects(lease.heartbeatNow(), (error: unknown) => error === reason);
  await assert.rejects(
    lease.recordProgress({ kind: "tool_completed", evidenceHash: "e".repeat(64) }),
    (error: unknown) => error === reason,
  );
  // stop after failure keeps the failure and the aborted signal.
  await lease.stop();
  assert.equal(lease.failure, reason);
  assert.equal(lease.signal.aborted, true);
});

test("an abort without a reason fails the lease with CALLER_WORK_EXECUTION_ABORTED", async () => {
  const runId = "run_unit_lease_abort_plain";
  const { home, claim } = await claimedWork(runId);
  const target = new EventTarget() as AbortSignal;
  Object.defineProperties(target, { aborted: { value: false, writable: true }, reason: { value: undefined } });
  const lease = await startCueLineCallerWorkLease(claim, { home, signal: target, heartbeatIntervalMs: 10_000 });
  target.dispatchEvent(new Event("abort"));
  await waitForAbort(lease.signal);
  assert.ok(hasCode("CALLER_WORK_EXECUTION_ABORTED")(lease.failure));
  await lease.stop();
});

test("missing progress hands the job to controller review and aborts the executor", async () => {
  const runId = "run_unit_lease_progress";
  const { home, job, claim } = await claimedWork(runId);
  const lease: CueLineCallerWorkLease = await startCueLineCallerWorkLease(claim, {
    home,
    heartbeatIntervalMs: 10_000,
    progressTimeoutMs: 30,
    maxExecutionMs: 60_000,
  });
  await waitForAbort(lease.signal);
  await lease.stop();

  assert.ok(hasCode("CALLER_WORK_PROGRESS_REVIEW_REQUIRED")(lease.failure));
  assert.equal(
    (lease.failure as CueLineError & { details: { progress_timeout_ms: number } }).details.progress_timeout_ms,
    30,
  );
  assert.equal(lease.active, false);
  await assert.rejects(
    lease.recordProgress({ kind: "tool_completed", evidenceHash: "f".repeat(64) }),
    hasCode("CALLER_WORK_PROGRESS_REVIEW_REQUIRED"),
  );
  const state = await loadCueLineRunState(runId, { home });
  assert.equal(state.jobs[job.jobId]?.status, "ambiguous");
});

test("a rejected durable heartbeat fails the lease and aborts the executor", async () => {
  const runId = "run_unit_lease_heartbeat_fail";
  const { home, job, claim } = await claimedWork(runId);
  const lease = await startCueLineCallerWorkLease(claim, { home, heartbeatIntervalMs: 10_000 });
  await cancelCueLineJob(runId, job.jobId, { home });

  await assert.rejects(lease.heartbeatNow(), hasCode("CALLER_WORK_NOT_ACTIVE"));
  await waitForAbort(lease.signal);
  assert.equal(lease.active, false);
  assert.notEqual(lease.failure, undefined);
  assert.throws(() => lease.assertHealthy());
  await assert.rejects(lease.heartbeatNow(), (error: unknown) => error === lease.failure);
  await lease.stop();
});

for (const [limit, code, review] of [
  ["progress", "CALLER_WORK_PROGRESS_REVIEW_REQUIRED", "progress_stalled"],
  ["max execution", "CALLER_WORK_MAX_EXECUTION_EXCEEDED", "max_execution_elapsed"],
] as const) {
  test(`restarting after the durable ${limit} deadline requires review instead of renewing`, async () => {
    const runId = `run_unit_lease_restart_${limit.replace(" ", "_")}`;
    let current = new Date("2026-10-26T00:00:00.000Z");
    const now = () => current;
    const { home, job, claim } = await claimedWork(runId, 5_000, now);
    const limits = limit === "progress"
      ? { progressTimeoutMs: 1_000, maxExecutionMs: 5_000 }
      : { progressTimeoutMs: 5_000, maxExecutionMs: 1_000 };
    const first = await startCueLineCallerWorkLease(claim, { home, now, heartbeatIntervalMs: 1_000, ...limits });
    await first.stop();

    current = new Date("2026-10-26T00:00:01.100Z");
    await assert.rejects(
      startCueLineCallerWorkLease(claim, { home, now, heartbeatIntervalMs: 1_000, ...limits }),
      hasCode(code),
    );
    assert.equal((await loadCueLineRunState(runId, { home })).jobs[job.jobId]?.status, "ambiguous");
    const events = await readEvents(runPaths(home, runId).events);
    assert.equal(events.filter((event) => event.type === "caller_work_heartbeat").length, 0);
    const reviewEvent = events.find((event) => JSON.stringify(event.payload).includes(review));
    assert.notEqual(reviewEvent, undefined);
  });
}
