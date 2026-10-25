import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { sweepCueLineRuns } from "../../src/api.js";
import { initialRunState, reduceRunState } from "../../src/core/state-machine.js";
import { runPaths } from "../../src/state/paths.js";
import { readRuntimeLease, RuntimeLease } from "../../src/state/runtime-lease.js";
import { JobStatusStore } from "../../src/jobs/status.js";
import { readAuthoritativeRunEvents, RunStore } from "../../src/state/store.js";
import { main } from "../../src/cli/main.js";
import type { CliIo } from "../../src/cli/io.js";

const NOW = new Date("2026-07-17T00:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

async function home(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "cueline-run-sweep-"));
}

async function seedRun(
  stateHome: string,
  runId: string,
  timestamp: string,
  options: { executor?: "caller" | "process"; terminal?: "run_completed" } = {},
): Promise<void> {
  const executor = options.executor ?? "process";
  const store = await RunStore.create({
    home: stateHome,
    runId,
    initialState: initialRunState(runId, "", executor),
    reducer: reduceRunState,
    now: () => new Date(timestamp),
  });
  await store.append("run_created", {
    request: `PRIVATE REQUEST ${runId}`,
    executor,
  });
  if (options.terminal === "run_completed") {
    await store.append("run_completed", { final_delivery_text: "done" });
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function readEvents(stateHome: string, runId: string): Promise<string> {
  return JSON.stringify(await readAuthoritativeRunEvents(stateHome, runId));
}

// Include both the legacy file and every segment: comparing parsed events alone
// would miss byte changes, while comparing only events.jsonl misses new segments.
async function eventBytes(stateHome: string, runId: string) {
  const file = runPaths(stateHome, runId).events;
  const files = await exists(file) ? [file] : [];
  const directory = `${file}.segments`;
  if (await exists(directory)) {
    files.push(...(await readdir(directory)).sort().map((name) => path.join(directory, name)));
  }
  return Promise.all(files.map(async (name) => [name, await readFile(name)] as const));
}

function collectingIo(): { io: CliIo; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    io: {
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
    },
  };
}

test("a dry run reports stale ownerless running runs without touching evidence", async () => {
  const stateHome = await home();
  await seedRun(stateHome, "run_orphan", "2026-07-15T00:00:00.000Z");
  await seedRun(stateHome, "run_fresh", "2026-07-16T23:30:00.000Z");
  await seedRun(stateHome, "run_done", "2026-07-15T00:00:00.000Z", {
    terminal: "run_completed",
  });
  await seedRun(stateHome, "run_by_caller", "2026-07-15T00:00:00.000Z", {
    executor: "caller",
  });
  const eventsBefore = await readEvents(stateHome, "run_orphan");
  const keptBefore = await Promise.all(
    ["run_fresh", "run_done"].map((runId) => eventBytes(stateHome, runId)),
  );

  const result = await sweepCueLineRuns({
    home: stateHome,
    staleMs: 24 * HOUR_MS,
    now: () => NOW,
  });

  assert.equal(result.apply, false);
  assert.equal(result.sweptRuns, 0);
  assert.equal(result.eligibleRuns, 2);
  const byRun = new Map(result.decisions.map((entry) => [entry.runId, entry]));
  assert.equal(byRun.get("run_orphan")?.decision, "eligible");
  assert.equal(byRun.get("run_by_caller")?.decision, "eligible");
  assert.equal(byRun.get("run_fresh")?.reason, "too_recent");
  assert.equal(byRun.get("run_done")?.reason, "not_running");
  assert.equal(await readEvents(stateHome, "run_orphan"), eventsBefore);
  assert.deepEqual(
    await Promise.all(["run_fresh", "run_done"].map((runId) => eventBytes(stateHome, runId))),
    keptBefore,
  );
});

test("apply closes a stale caller-executed orphan as cancelled with an explicit reason", async () => {
  const stateHome = await home();
  await seedRun(stateHome, "run_by_caller", "2026-07-15T00:00:00.000Z", {
    executor: "caller",
  });

  const result = await sweepCueLineRuns({
    home: stateHome,
    staleMs: 24 * HOUR_MS,
    apply: true,
    now: () => NOW,
  });

  assert.equal(result.sweptRuns, 1);
  assert.equal(
    result.decisions.find((entry) => entry.runId === "run_by_caller")?.decision,
    "swept",
  );
  assert.equal(await exists(runPaths(stateHome, "run_by_caller").runDir), true);
  const events = await readEvents(stateHome, "run_by_caller");
  assert.match(events, /run_cancelled/);
  assert.match(events, /stale ownerless run closed by runs sweep/);
});

test("apply closes a stale orphan fail-closed with durable evidence and keeps its directory", async () => {
  const stateHome = await home();
  await seedRun(stateHome, "run_orphan", "2026-07-15T00:00:00.000Z");

  const result = await sweepCueLineRuns({
    home: stateHome,
    staleMs: 24 * HOUR_MS,
    apply: true,
    now: () => NOW,
  });

  assert.equal(result.sweptRuns, 1);
  assert.equal(
    result.decisions.find((entry) => entry.runId === "run_orphan")?.decision,
    "swept",
  );
  assert.equal(await exists(runPaths(stateHome, "run_orphan").runDir), true);
  const events = await readEvents(stateHome, "run_orphan");
  assert.match(events, /runtime_reconciliation_started/);
  assert.match(events, /runtime_owner_loss_reconciled/);
  assert.match(events, /RUNTIME_OWNER_LOST/);

  // Idempotent: the closed run is terminal on the next sweep.
  const beforeAgain = await eventBytes(stateHome, "run_orphan");
  const again = await sweepCueLineRuns({
    home: stateHome,
    staleMs: 24 * HOUR_MS,
    apply: true,
    now: () => NOW,
  });
  assert.equal(again.sweptRuns, 0);
  assert.equal(
    again.decisions.find((entry) => entry.runId === "run_orphan")?.reason,
    "not_running",
  );
  assert.deepEqual(await eventBytes(stateHome, "run_orphan"), beforeAgain);
});

test("a run with an active runtime owner is never swept even when its events are old", async () => {
  const stateHome = await home();
  await seedRun(stateHome, "run_alive", "2026-07-01T00:00:00.000Z");
  const lease = await RuntimeLease.claim({ home: stateHome, runId: "run_alive" });
  try {
    const before = await eventBytes(stateHome, "run_alive");
    const result = await sweepCueLineRuns({
      home: stateHome,
      staleMs: 24 * HOUR_MS,
      apply: true,
    });
    const decision = result.decisions.find((entry) => entry.runId === "run_alive");
    assert.equal(decision?.decision, "kept");
    assert.equal(decision?.reason, "runtime_active");
    const events = await readEvents(stateHome, "run_alive");
    assert.doesNotMatch(events, /runtime_reconciliation_started/);
    assert.deepEqual(await eventBytes(stateHome, "run_alive"), before);
  } finally {
    await lease.release();
  }
});

test("the CLI wires dry-run, apply, JSON, and usage validation", async () => {
  const stateHome = await home();
  await seedRun(stateHome, "run_orphan", "2026-07-15T00:00:00.000Z");
  const environment = { CUELINE_HOME: stateHome, HOME: stateHome };

  const dry = collectingIo();
  assert.equal(await main(["runs", "sweep", "--json"], environment, dry.io), 0);
  const dryReport = JSON.parse(dry.lines.join("\n")) as {
    schema: string;
    apply: boolean;
    staleMs: number;
    eligibleRuns: number;
    sweptRuns: number;
  };
  assert.equal(dryReport.schema, "cueline-runs-sweep/1");
  assert.equal(dryReport.apply, false);
  assert.equal(dryReport.staleMs, 24 * HOUR_MS);
  assert.equal(dryReport.eligibleRuns, 1);
  assert.equal(dryReport.sweptRuns, 0);
  assert.doesNotMatch(dry.lines.join("\n"), /PRIVATE REQUEST/);

  const applied = collectingIo();
  assert.equal(
    await main(
      ["runs", "sweep", "--stale-hours", "24", "--apply"],
      environment,
      applied.io,
    ),
    0,
  );
  assert.match(applied.lines.join("\n"), /run\trun_orphan\tswept/);
  assert.equal(await exists(runPaths(stateHome, "run_orphan").runDir), true);

  const badHours = collectingIo();
  assert.equal(
    await main(["runs", "sweep", "--stale-hours", "-1"], environment, badHours.io),
    2,
  );
  const badFlag = collectingIo();
  assert.equal(
    await main(["runs", "sweep", "--older-than-days", "1"], environment, badFlag.io),
    2,
  );
});

test("a blank --stale-hours is a usage error, not a zero-hour cutoff", async () => {
  const stateHome = await home();
  await seedRun(stateHome, "run_orphan", "2026-07-15T00:00:00.000Z");
  const environment = { CUELINE_HOME: stateHome, HOME: stateHome };
  const before = await readEvents(stateHome, "run_orphan");

  for (const blank of ["", "   "]) {
    const rejected = collectingIo();
    assert.equal(
      await main(
        ["runs", "sweep", "--stale-hours", blank, "--apply"],
        environment,
        rejected.io,
      ),
      2,
    );
    assert.equal(await readEvents(stateHome, "run_orphan"), before);
  }
});

test("invalid sweep ages reject before touching any event evidence", async () => {
  const stateHome = await home();
  await seedRun(stateHome, "run_invalid_age", "2026-07-15T00:00:00.000Z");
  const before = await eventBytes(stateHome, "run_invalid_age");
  for (const staleMs of [-1, NaN, Infinity]) {
    await assert.rejects(
      sweepCueLineRuns({ home: stateHome, staleMs, apply: true, now: () => NOW }),
      { code: "RUN_SWEEP_AGE_INVALID" },
    );
    assert.deepEqual(await eventBytes(stateHome, "run_invalid_age"), before);
  }
});

test("live workers are kept without appending reconciliation evidence", async () => {
  const stateHome = await home();
  const runId = "run_live_worker";
  await seedRun(stateHome, runId, "2026-07-15T00:00:00.000Z");
  // Obtain the live identity through the same lease helper used by owner tests.
  // No process is spawned and the test never sends a signal.
  const lease = await RuntimeLease.claim({ home: stateHome, runId });
  let pid: number;
  try {
    pid = Number((await readRuntimeLease(stateHome, runId)).pid);
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
  } finally {
    await lease.release();
  }
  const store = await RunStore.load({
    home: stateHome,
    runId,
    initialState: initialRunState(runId, "", "process"),
    reducer: reduceRunState,
    now: () => new Date("2026-07-15T00:00:00.000Z"),
  });
  const spec = {
    job_key: "live_worker",
    lane: "default",
    mode: "advise" as const,
    task: "still running",
  };
  await store.append("job_registered", {
    job: {
      jobId: "job_live_worker",
      jobKey: spec.job_key,
      required: true,
      spec,
      status: "running",
      output: null,
      error: null,
    },
  });
  await new JobStatusStore(stateHome).write({
    jobId: "job_live_worker",
    runId,
    jobKey: spec.job_key,
    lane: spec.lane,
    mode: spec.mode,
    pid,
    execution: "foreground",
    status: "running",
    startedAt: "2026-07-15T00:00:00.000Z",
  });
  const before = await eventBytes(stateHome, runId);
  const result = await sweepCueLineRuns({ home: stateHome, staleMs: HOUR_MS, apply: true, now: () => NOW });
  assert.equal(result.decisions[0]?.decision, "kept");
  assert.equal(result.decisions[0]?.reason, "workers_alive");
  assert.equal(result.sweptRuns, 0);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(await eventBytes(stateHome, runId), before);
});

for (const failure of [new Error("injected claim failure"), "injected non-Error failure"]) {
  test(`a failed run does not stop other runs: ${String(failure)}`, async (t) => {
    const stateHome = await home();
    for (const runId of ["run_a_before", "run_b_failure", "run_c_after"]) {
      await seedRun(stateHome, runId, "2026-07-15T00:00:00.000Z");
    }
    const before = await eventBytes(stateHome, "run_b_failure");
    const claim = RuntimeLease.claim.bind(RuntimeLease);
    t.mock.method(RuntimeLease, "claim", async (options: Parameters<typeof claim>[0]) => {
      if (options.runId === "run_b_failure") throw failure;
      return claim(options);
    });
    const result = await sweepCueLineRuns({ home: stateHome, staleMs: HOUR_MS, apply: true, now: () => NOW });
    assert.deepEqual(result.errors, [{ runId: "run_b_failure", message: failure instanceof Error ? failure.message : failure }]);
    assert.equal(result.keptRuns, 1);
    assert.equal(result.sweptRuns, 2);
    const decisions = new Map(result.decisions.map((entry) => [entry.runId, entry]));
    assert.equal(decisions.get("run_b_failure")?.decision, "kept");
    assert.equal(decisions.get("run_b_failure")?.reason, "sweep_failed");
    for (const runId of ["run_a_before", "run_c_after"]) {
      assert.equal(decisions.get(runId)?.decision, "swept");
      assert.match(await readEvents(stateHome, runId), /runtime_owner_loss_reconciled/);
    }
    assert.deepEqual(await eventBytes(stateHome, "run_b_failure"), before);
  });
}

test("sweep keeps an unparseable last-event timestamp byte-for-byte", async () => {
  const stateHome = await home();
  const runId = "run_bad_timestamp";
  await seedRun(stateHome, runId, "2026-07-15T00:00:00.000Z");
  const segment = path.join(`${runPaths(stateHome, runId).events}.segments`, "0000000000000001.json");
  const event = JSON.parse(await readFile(segment, "utf8"));
  event.timestamp = "not-a-timestamp";
  await writeFile(segment, `${JSON.stringify(event)}\n`);
  const before = await eventBytes(stateHome, runId);
  const result = await sweepCueLineRuns({ home: stateHome, staleMs: HOUR_MS, apply: true, now: () => NOW });
  assert.equal(result.decisions[0]?.decision, "kept");
  assert.equal(result.decisions[0]?.reason, "unparseable_timestamp");
  assert.deepEqual(result.errors, []);
  assert.deepEqual(await eventBytes(stateHome, runId), before);
});

for (const executor of ["caller", "process"] as const) {
  test(`${executor}: settlement rechecks terminal state after a stale listing`, async (t) => {
    const stateHome = await home();
    const runId = "run_terminal_race";
    await seedRun(stateHome, runId, "2026-07-15T00:00:00.000Z", { executor, terminal: "run_completed" });
    const before = await eventBytes(stateHome, runId);
    const load = RunStore.load.bind(RunStore);
    let reads = 0;
    // Model a stale listing while leaving the authoritative terminal events intact.
    t.mock.method(RunStore, "load", async (...args: Parameters<typeof load>) => {
      const store = await load(...args);
      if (++reads === 1) {
        const state = store.state as ReturnType<typeof initialRunState>;
        Object.defineProperty(store, "state", { get: () => ({ ...state, status: "running" }) });
      }
      return store;
    });
    const result = await sweepCueLineRuns({ home: stateHome, staleMs: HOUR_MS, apply: true, now: () => NOW });
    assert.equal(result.decisions[0]?.decision, "kept");
    assert.equal(result.decisions[0]?.reason, "already_terminal");
    assert.equal(result.sweptRuns, 0);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(await eventBytes(stateHome, runId), before);
  });

  test(`${executor}: a stale but living owner is kept without event writes`, async () => {
    const stateHome = await home();
    const runId = "run_stale_owner";
    await seedRun(stateHome, runId, "2026-07-15T00:00:00.000Z", { executor });
    const lease = await RuntimeLease.claim({ home: stateHome, runId, now: () => new Date("2026-07-15T00:00:00.000Z") });
    try {
      const before = await eventBytes(stateHome, runId);
      const result = await sweepCueLineRuns({ home: stateHome, staleMs: HOUR_MS, apply: true, now: () => NOW });
      assert.equal(result.decisions[0]?.decision, "kept");
      assert.equal(result.decisions[0]?.reason, "owner_alive");
      assert.deepEqual(result.errors, []);
      assert.deepEqual(await eventBytes(stateHome, runId), before);
    } finally {
      await lease.release();
    }
  });
}

test("unreadable event evidence is kept byte-for-byte", async () => {
  const stateHome = await home();
  const runId = "run_unreadable";
  await seedRun(stateHome, runId, "2026-07-15T00:00:00.000Z");
  await writeFile(path.join(`${runPaths(stateHome, runId).events}.segments`, "0000000000000001.json"), "{broken json\n");
  const before = await eventBytes(stateHome, runId);
  const result = await sweepCueLineRuns({ home: stateHome, staleMs: HOUR_MS, apply: true, now: () => NOW });
  assert.equal(result.decisions[0]?.decision, "kept");
  assert.equal(result.decisions[0]?.reason, "unreadable");
  assert.deepEqual(await eventBytes(stateHome, runId), before);
});
