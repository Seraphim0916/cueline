import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { jobId } from "../../src/core/ids.js";
import { initialRunState, reduceRunState } from "../../src/core/state-machine.js";
import { loadCueLineRunStatusAt } from "../../src/observation/run-status-at.js";
import { runPaths } from "../../src/state/paths.js";
import { persistRuntimeOwnerRetirements } from "../../src/state/runtime-retirement.js";
import { RunStore } from "../../src/state/store.js";

async function home(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "cueline-unit-status-at-"));
}

async function seedRun(
  stateHome: string,
  runId: string,
): Promise<RunStore<ReturnType<typeof initialRunState>>> {
  const store = await RunStore.create({
    home: stateHome,
    runId,
    initialState: initialRunState(runId, "", "process"),
    reducer: reduceRunState,
    now: () => new Date("2026-10-26T00:00:00.000Z"),
  });
  await store.append("run_created", {
    request: "status-at request",
    executor: "process",
    allow_process_execution: true,
  });
  return store;
}

async function registerJob(
  store: RunStore<ReturnType<typeof initialRunState>>,
  runId: string,
  key: string,
  status: "pending" | "running" | "succeeded" | "failed",
): Promise<void> {
  const spec = { job_key: key, lane: "default", mode: "advise" as const, task: key, required: true };
  await store.append("job_registered", {
    job: {
      jobId: jobId(runId, key, spec),
      jobKey: key,
      required: true,
      spec,
      status,
      output: null,
      error: null,
    },
  });
}

test("each historical sequence reflects only the events up to it", async () => {
  const stateHome = await home();
  const runId = "run_unit_status_at_history";
  const store = await seedRun(stateHome, runId);
  await registerJob(store, runId, "alpha", "pending");
  await registerJob(store, runId, "beta", "succeeded");
  await registerJob(store, runId, "gamma", "succeeded");
  await store.append("run_completed", { final_delivery_text: "done" });

  const first = await loadCueLineRunStatusAt(runId, { home: stateHome, sequence: 1 });
  assert.equal(first.schema, "cueline-status-at/0.1");
  assert.equal(first.requestedSequence, 1);
  assert.equal(first.latestSequence, 5);
  assert.equal(first.latestAuthoritativeSequence, 5);
  assert.equal(first.totalEvents, 5);
  assert.equal(first.authoritativeEventsApplied, 1);
  assert.equal(first.ignoredNonAuthoritativeEventsThroughSequence, 0);
  assert.deepEqual(first.asOf, { type: "run_created", timestamp: "2026-10-26T00:00:00.000Z" });
  assert.equal(first.state.status, "running");
  assert.equal(first.state.executor, "process");
  assert.equal(first.state.allowProcessExecution, true);
  assert.deepEqual(first.state.jobs, { total: 0, counts: {} });
  assert.equal(first.state.finalDeliveryAvailable, false);

  const middle = await loadCueLineRunStatusAt(runId, { home: stateHome, sequence: 3 });
  assert.equal(middle.asOf.type, "job_registered");
  assert.deepEqual(middle.state.jobs, { total: 2, counts: { pending: 1, succeeded: 1 } });
  assert.equal(middle.state.status, "running");

  const last = await loadCueLineRunStatusAt(runId, { home: stateHome, sequence: 5 });
  assert.equal(last.asOf.type, "run_completed");
  assert.equal(last.state.status, "complete");
  assert.equal(last.state.finalDeliveryAvailable, true);
  assert.deepEqual(last.state.jobs, { total: 3, counts: { pending: 1, succeeded: 2 } });
  assert.equal(last.state.blockedReasonAvailable, false);
  assert.equal(last.state.cancelledReasonAvailable, false);
  assert.equal(last.state.lastFailureCode, null);
});

test("the latest sequence is accepted and one past it is rejected as ahead", async () => {
  const stateHome = await home();
  const runId = "run_unit_status_at_ahead";
  const store = await seedRun(stateHome, runId);
  await store.append("notice", { message: "second" });

  const latest = await loadCueLineRunStatusAt(runId, { home: stateHome, sequence: 2 });
  assert.equal(latest.requestedSequence, latest.latestSequence);

  await assert.rejects(
    loadCueLineRunStatusAt(runId, { home: stateHome, sequence: 3 }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "RUN_STATUS_AT_SEQUENCE_AHEAD");
      assert.match((error as Error).message, /is at event 2, behind requested sequence 3/);
      return true;
    },
  );
});

test("a blocked or cancelled run reports which reason is available", async () => {
  const stateHome = await home();
  const blockedId = "run_unit_status_at_blocked";
  const blocked = await seedRun(stateHome, blockedId);
  await blocked.append("run_blocked", { reason: "needs operator" });
  const cancelledId = "run_unit_status_at_cancelled";
  const cancelled = await seedRun(stateHome, cancelledId);
  await cancelled.append("run_cancelled", { reason: "operator stop" });

  const blockedAt = await loadCueLineRunStatusAt(blockedId, { home: stateHome, sequence: 2 });
  assert.equal(blockedAt.state.status, "blocked");
  assert.equal(blockedAt.state.blockedReasonAvailable, true);
  assert.equal(blockedAt.state.cancelledReasonAvailable, false);

  const cancelledAt = await loadCueLineRunStatusAt(cancelledId, { home: stateHome, sequence: 2 });
  assert.equal(cancelledAt.state.status, "cancelled");
  assert.equal(cancelledAt.state.cancelledReasonAvailable, true);
  assert.equal(cancelledAt.state.blockedReasonAvailable, false);
});

test("events written after an owner's retirement cutoff are counted but not applied", async () => {
  const stateHome = await home();
  const runId = "run_unit_status_at_retired";
  await seedRun(stateHome, runId);
  // A retired owner's late writes stay on disk; only events at or below its
  // cutoff are authoritative.
  const segments = `${runPaths(stateHome, runId).events}.segments`;
  const owned = (sequence: number, type: string, payload: unknown) =>
    writeFile(
      path.join(segments, `${String(sequence).padStart(16, "0")}.json`),
      JSON.stringify({
        sequence,
        timestamp: `2026-10-26T00:00:0${sequence}.000Z`,
        type,
        payload,
        runtime_owner_id: "owner-retired",
      }),
      "utf8",
    );
  await owned(2, "notice", { message: "accepted owner write" });
  await owned(3, "run_completed", { final_delivery_text: "late" });
  await persistRuntimeOwnerRetirements(stateHome, runId, [
    { owner_id: "owner-retired", events_after_sequence: 2, retired_at: "2026-10-26T00:00:03.000Z" },
  ]);

  const at3 = await loadCueLineRunStatusAt(runId, { home: stateHome, sequence: 3 });
  assert.equal(at3.totalEvents, 3);
  assert.equal(at3.latestSequence, 3);
  assert.equal(at3.authoritativeEvents, 2);
  assert.equal(at3.latestAuthoritativeSequence, 2);
  assert.equal(at3.authoritativeEventsApplied, 2);
  assert.equal(at3.ignoredNonAuthoritativeEventsThroughSequence, 1);
  assert.equal(at3.asOf.type, "run_completed");
  assert.equal(at3.state.status, "running", "the ignored completion must not be reduced");
  assert.equal(at3.state.finalDeliveryAvailable, false);

  const at2 = await loadCueLineRunStatusAt(runId, { home: stateHome, sequence: 2 });
  assert.equal(at2.ignoredNonAuthoritativeEventsThroughSequence, 0);
  assert.equal(at2.authoritativeEventsApplied, 2);
});

test("home is resolved from CUELINE_HOME when no explicit home is passed", async () => {
  const stateHome = await home();
  const runId = "run_unit_status_at_env";
  await seedRun(stateHome, runId);

  const result = await loadCueLineRunStatusAt(runId, {
    environment: { CUELINE_HOME: stateHome, HOME: stateHome },
    sequence: 1,
  });
  assert.equal(result.runId, runId);
  assert.equal(result.state.conversationBound, false);
});

test("an unknown run fails closed and creates no run directory", async () => {
  const stateHome = await home();
  await assert.rejects(
    loadCueLineRunStatusAt("run_unit_status_at_absent", { home: stateHome, sequence: 1 }),
    (error: unknown) => typeof (error as { code?: string }).code === "string",
  );
  const runsDirectory = runPaths(stateHome, "run_unit_status_at_absent").runsDir;
  const entries = await readdir(runsDirectory).catch(() => [] as string[]);
  assert.deepEqual(entries, []);
});
