import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CueLineError } from "../../src/core/errors.js";
import { jobId } from "../../src/core/ids.js";
import { initialRunState, reduceRunState } from "../../src/core/state-machine.js";
import { compareCueLineRuns } from "../../src/observation/run-diff.js";
import { RunStore } from "../../src/state/store.js";

const NOW = new Date("2026-10-26T00:00:00.000Z");

async function home(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "cueline-unit-diff-"));
}

async function seedRun(
  stateHome: string,
  runId: string,
  created: Record<string, unknown> = {},
): Promise<RunStore<ReturnType<typeof initialRunState>>> {
  const store = await RunStore.create({
    home: stateHome,
    runId,
    initialState: initialRunState(runId, "", "caller"),
    reducer: reduceRunState,
    now: () => NOW,
  });
  await store.append("run_created", { request: `request ${runId}`, executor: "caller", ...created });
  return store;
}

async function registerJob(
  store: RunStore<ReturnType<typeof initialRunState>>,
  runId: string,
  jobKey: string,
): Promise<void> {
  const spec = { job_key: jobKey, lane: "default", mode: "advise" as const, task: "t", required: true };
  await store.append("job_registered", {
    job: {
      jobId: jobId(runId, jobKey, spec),
      jobKey,
      required: true,
      spec,
      status: "pending",
      output: null,
      error: null,
    },
  });
}

test("two runs with the same durable shape are equivalent even though their ids differ", async () => {
  const stateHome = await home();
  await seedRun(stateHome, "run_diff_left");
  await seedRun(stateHome, "run_diff_right");

  const diff = await compareCueLineRuns("run_diff_left", "run_diff_right", {
    home: stateHome,
    now: () => NOW,
  });
  assert.equal(diff.schema, "cueline-run-diff/0.1");
  assert.equal(diff.equivalent, true);
  assert.deepEqual(diff.changes, []);
  assert.equal(diff.left.runId, "run_diff_left");
  assert.equal(diff.right.runId, "run_diff_right");
  assert.equal(diff.left.jobs.total, 0);
  assert.ok(Object.values(diff.left.jobs.counts).every((count) => count === 0));
  // The request text is private evidence and never reaches the projection.
  assert.doesNotMatch(JSON.stringify(diff), /request run_diff/);
});

test("a run compared with itself is equivalent", async () => {
  const stateHome = await home();
  const store = await seedRun(stateHome, "run_diff_self");
  await registerJob(store, "run_diff_self", "audit");
  const diff = await compareCueLineRuns("run_diff_self", "run_diff_self", { home: stateHome });
  assert.equal(diff.equivalent, true);
  assert.deepEqual(diff.left, diff.right);
});

test("changes are sorted by field and a job status absent on one side compares as zero", async () => {
  const stateHome = await home();
  const left = await seedRun(stateHome, "run_diff_jobs", { max_rounds: 3, max_stagnant_rounds: 2 });
  await registerJob(left, "run_diff_jobs", "audit");
  await registerJob(left, "run_diff_jobs", "review");
  await seedRun(stateHome, "run_diff_empty", { max_rounds: null });

  const diff = await compareCueLineRuns("run_diff_jobs", "run_diff_empty", {
    home: stateHome,
    now: () => NOW,
  });
  assert.equal(diff.equivalent, false);
  const fields = diff.changes.map((change) => change.field);
  assert.deepEqual(fields, [...fields].sort());
  assert.ok(!fields.includes("runId"), "run ids are never reported as a change");

  const byField = new Map(diff.changes.map((change) => [change.field, change]));
  assert.deepEqual(byField.get("jobs.counts.pending"), {
    field: "jobs.counts.pending",
    left: 2,
    right: 0,
  });
  assert.deepEqual(byField.get("jobs.total"), { field: "jobs.total", left: 2, right: 0 });
  assert.deepEqual(byField.get("maxRounds"), { field: "maxRounds", left: 3, right: null });
  assert.deepEqual(byField.get("maxStagnantRounds")?.left, 2);
  assert.deepEqual(byField.get("lastEventSequence"), {
    field: "lastEventSequence",
    left: 3,
    right: 1,
  });

  const reversed = await compareCueLineRuns("run_diff_empty", "run_diff_jobs", {
    home: stateHome,
    now: () => NOW,
  });
  assert.deepEqual(
    reversed.changes,
    diff.changes.map((change) => ({ field: change.field, left: change.right, right: change.left })),
  );
});

test("the projection copies job counts instead of sharing the summary object", async () => {
  const stateHome = await home();
  const store = await seedRun(stateHome, "run_diff_copy");
  await registerJob(store, "run_diff_copy", "audit");
  const diff = await compareCueLineRuns("run_diff_copy", "run_diff_copy", { home: stateHome });
  assert.notEqual(diff.left.jobs.counts, diff.right.jobs.counts);
  diff.left.jobs.counts.pending = 99;
  assert.equal(diff.right.jobs.counts.pending, 1);
});

test("an unknown run id fails instead of diffing against an empty projection", async () => {
  const stateHome = await home();
  await seedRun(stateHome, "run_diff_present");
  for (const [left, right] of [
    ["run_diff_present", "run_diff_absent"],
    ["run_diff_absent", "run_diff_present"],
  ] as const) {
    await assert.rejects(
      compareCueLineRuns(left, right, { home: stateHome }),
      (error: unknown) => error instanceof CueLineError,
    );
  }
});
