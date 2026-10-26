import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { sweepCueLineRuns } from "../../src/api-run-sweep.js";
import { initialRunState, reduceRunState } from "../../src/core/state-machine.js";
import { JobStatusStore } from "../../src/jobs/status.js";
import { runPaths } from "../../src/state/paths.js";
import { RunStore } from "../../src/state/store.js";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const STALE = "2026-10-20T00:00:00.000Z";

async function home(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "cueline-unit-sweep-"));
}

async function seedRun(
  stateHome: string,
  runId: string,
  timestamp: string,
  executor: "caller" | "process" = "process",
): Promise<RunStore<ReturnType<typeof initialRunState>>> {
  const store = await RunStore.create({
    home: stateHome,
    runId,
    initialState: initialRunState(runId, "", executor),
    reducer: reduceRunState,
    now: () => new Date(timestamp),
  });
  await store.append("run_created", { request: `request ${runId}`, executor });
  return store;
}

async function registerRunningJob(
  store: RunStore<ReturnType<typeof initialRunState>>,
  id: string,
  status: "running" | "succeeded" = "running",
): Promise<void> {
  const spec = { job_key: id, lane: "default", mode: "advise" as const, task: "t" };
  await store.append("job_registered", {
    job: { jobId: id, jobKey: id, required: true, spec, status, output: null, error: null },
  });
}

async function eventFiles(stateHome: string, runId: string): Promise<string[]> {
  const directory = `${runPaths(stateHome, runId).events}.segments`;
  const names = (await readdir(directory)).sort();
  return Promise.all(names.map((name) => readFile(path.join(directory, name), "utf8")));
}

function byRun(result: Awaited<ReturnType<typeof sweepCueLineRuns>>) {
  return new Map(result.decisions.map((decision) => [decision.runId, decision]));
}

test("negative and non-finite ages are rejected; zero is a valid age", async () => {
  const stateHome = await home();
  for (const staleMs of [-1, -Infinity, Infinity, NaN]) {
    await assert.rejects(
      sweepCueLineRuns({ home: stateHome, staleMs, now: () => NOW }),
      { code: "RUN_SWEEP_AGE_INVALID" },
      `staleMs ${staleMs}`,
    );
  }
  const result = await sweepCueLineRuns({ home: stateHome, staleMs: 0, now: () => NOW });
  assert.equal(result.cutoff, NOW.toISOString());
  assert.equal(result.apply, false);
  assert.deepEqual(result.decisions, []);
});

test("the cutoff is exclusive: an event exactly at it is too recent, one millisecond older is eligible", async () => {
  const stateHome = await home();
  const cutoff = new Date(NOW.getTime() - HOUR_MS);
  await seedRun(stateHome, "run_at_cutoff", cutoff.toISOString());
  await seedRun(stateHome, "run_before_cutoff", new Date(cutoff.getTime() - 1).toISOString());

  const result = await sweepCueLineRuns({ home: stateHome, staleMs: HOUR_MS, now: () => NOW });
  assert.equal(result.cutoff, cutoff.toISOString());
  const decisions = byRun(result);
  assert.equal(decisions.get("run_at_cutoff")?.decision, "kept");
  assert.equal(decisions.get("run_at_cutoff")?.reason, "too_recent");
  assert.equal(decisions.get("run_before_cutoff")?.decision, "eligible");
  assert.equal(decisions.get("run_before_cutoff")?.reason, undefined);
  assert.equal(result.eligibleRuns, 1);
  assert.equal(result.keptRuns, 1);
  assert.equal(result.sweptRuns, 0);
});

test("a dry run classifies unreadable and terminal runs and writes nothing", async () => {
  const stateHome = await home();
  await mkdir(runPaths(stateHome, "run_unreadable").runDir, { recursive: true });
  const done = await seedRun(stateHome, "run_done", STALE);
  await done.append("run_completed", { final_delivery_text: "done" });
  await seedRun(stateHome, "run_stale", STALE);
  const before = await eventFiles(stateHome, "run_stale");

  const result = await sweepCueLineRuns({ home: stateHome, staleMs: HOUR_MS, now: () => NOW });
  const decisions = byRun(result);
  assert.deepEqual(decisions.get("run_unreadable"), {
    runId: "run_unreadable",
    decision: "kept",
    reason: "unreadable",
  });
  assert.equal(decisions.get("run_done")?.reason, "not_running");
  assert.equal(decisions.get("run_done")?.status, "complete");
  assert.equal(decisions.get("run_stale")?.decision, "eligible");
  assert.equal(result.keptRuns, 2);
  assert.equal(result.eligibleRuns, 1);
  assert.deepEqual(await eventFiles(stateHome, "run_stale"), before);
});

test("apply cancels a stale caller run once; a second sweep sees it terminal", async () => {
  const stateHome = await home();
  await seedRun(stateHome, "run_caller", STALE, "caller");

  const first = await sweepCueLineRuns({
    home: stateHome,
    staleMs: HOUR_MS,
    apply: true,
    now: () => NOW,
  });
  assert.equal(first.decisions[0]?.decision, "swept");
  assert.equal(first.sweptRuns, 1);
  assert.deepEqual(first.errors, []);
  const events = (await eventFiles(stateHome, "run_caller")).map(
    (text) => JSON.parse(text) as { type?: string; payload?: { reason?: string } },
  );
  const cancelled = events.find((event) => event.type === "run_cancelled");
  assert.match(cancelled?.payload?.reason ?? "", /stale ownerless run closed by runs sweep \(no durable event for 3600000ms\)/);

  const second = await sweepCueLineRuns({
    home: stateHome,
    staleMs: HOUR_MS,
    apply: true,
    now: () => NOW,
  });
  assert.equal(second.decisions[0]?.reason, "not_running");
  assert.equal(second.sweptRuns, 0);
});

test("a live pid on a finished job does not keep a stale process run alive", async () => {
  const stateHome = await home();
  const store = await seedRun(stateHome, "run_finished_job", STALE);
  await registerRunningJob(store, "job_finished", "succeeded");
  await new JobStatusStore(stateHome).write({
    jobId: "job_finished",
    runId: "run_finished_job",
    jobKey: "job_finished",
    pid: process.pid,
    execution: "foreground",
    status: "succeeded",
    startedAt: STALE,
  });

  const result = await sweepCueLineRuns({
    home: stateHome,
    staleMs: HOUR_MS,
    apply: true,
    now: () => NOW,
  });
  assert.equal(result.decisions[0]?.decision, "swept");
  assert.equal(result.sweptRuns, 1);
});

test("a running job owned by a live pid keeps the run and appends nothing", async () => {
  const stateHome = await home();
  const store = await seedRun(stateHome, "run_live_job", STALE);
  await registerRunningJob(store, "job_live");
  // The current test process is a pid that is guaranteed to be alive; no
  // signal is ever sent to it.
  await new JobStatusStore(stateHome).write({
    jobId: "job_live",
    runId: "run_live_job",
    jobKey: "job_live",
    pid: process.pid,
    execution: "foreground",
    status: "running",
    startedAt: STALE,
  });
  const before = await eventFiles(stateHome, "run_live_job");

  const result = await sweepCueLineRuns({
    home: stateHome,
    staleMs: HOUR_MS,
    apply: true,
    now: () => NOW,
  });
  assert.equal(result.decisions[0]?.reason, "workers_alive");
  assert.equal(result.keptRuns, 1);
  assert.deepEqual(await eventFiles(stateHome, "run_live_job"), before);
});

test("an unreadable job record keeps its run fail-closed and later runs are still swept", async () => {
  const stateHome = await home();
  const broken = await seedRun(stateHome, "run_a_broken", STALE);
  await registerRunningJob(broken, "job_broken");
  const jobFile = new JobStatusStore(stateHome).pathFor("job_broken");
  await mkdir(path.dirname(jobFile), { recursive: true });
  await writeFile(jobFile, "{corrupt", "utf8");
  await seedRun(stateHome, "run_b_healthy", STALE);

  const result = await sweepCueLineRuns({
    home: stateHome,
    staleMs: HOUR_MS,
    apply: true,
    now: () => NOW,
  });
  const decisions = byRun(result);
  // Listing already refuses the run, so the sweep never reaches settlement.
  assert.deepEqual(decisions.get("run_a_broken"), {
    runId: "run_a_broken",
    decision: "kept",
    reason: "unreadable",
  });
  assert.equal(decisions.get("run_b_healthy")?.decision, "swept");
  assert.equal(result.sweptRuns, 1);
  assert.deepEqual(result.errors, []);
});

test("home and clock default from the environment when not passed", async () => {
  const stateHome = await home();
  await seedRun(stateHome, "run_env", STALE);

  const result = await sweepCueLineRuns({
    environment: { CUELINE_HOME: stateHome, HOME: stateHome },
    staleMs: HOUR_MS,
  });
  assert.equal(result.home, stateHome);
  assert.equal(result.decisions[0]?.decision, "eligible");
  assert.ok(Date.parse(result.cutoff) > Date.parse(STALE));
});
