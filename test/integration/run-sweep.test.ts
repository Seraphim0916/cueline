import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { sweepCueLineRuns } from "../../src/api.js";
import { initialRunState, reduceRunState } from "../../src/core/state-machine.js";
import { runPaths } from "../../src/state/paths.js";
import { RuntimeLease } from "../../src/state/runtime-lease.js";
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
});

test("a run with an active runtime owner is never swept even when its events are old", async () => {
  const stateHome = await home();
  await seedRun(stateHome, "run_alive", "2026-07-01T00:00:00.000Z");
  const lease = await RuntimeLease.claim({ home: stateHome, runId: "run_alive" });
  try {
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
