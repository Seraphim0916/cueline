import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { pruneCueLineRuns } from "../../src/api.js";
import { initialRunState, reduceRunState } from "../../src/core/state-machine.js";
import { JobStatusStore } from "../../src/jobs/status.js";
import { runPaths } from "../../src/state/paths.js";
import {
  RuntimeLease,
  withRuntimeLeaseMutation,
} from "../../src/state/runtime-lease.js";
import { RunStore } from "../../src/state/store.js";
import { main } from "../../src/cli/main.js";
import type { CliIo } from "../../src/cli/io.js";

const NOW = new Date("2026-07-17T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

async function home(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "cueline-run-prune-"));
}

async function seedRun(
  stateHome: string,
  runId: string,
  timestamp: string,
  terminal?: "run_completed" | "run_blocked" | "run_cancelled",
): Promise<void> {
  const store = await RunStore.create({
    home: stateHome,
    runId,
    initialState: initialRunState(runId, "", "caller"),
    reducer: reduceRunState,
    now: () => new Date(timestamp),
  });
  await store.append("run_created", {
    request: `PRIVATE REQUEST ${runId}`,
    executor: "caller",
  });
  if (terminal === "run_completed") {
    await store.append("run_completed", { final_delivery_text: "done" });
  } else if (terminal === "run_blocked") {
    await store.append("run_blocked", { reason: "blocked for test" });
  } else if (terminal === "run_cancelled") {
    await store.append("run_cancelled", { reason: "cancelled for test" });
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

test("a dry run reports eligible old terminal runs without deleting anything", async () => {
  const stateHome = await home();
  await seedRun(stateHome, "run_old_done", "2026-06-01T00:00:00.000Z", "run_completed");
  await seedRun(stateHome, "run_fresh_done", "2026-07-16T00:00:00.000Z", "run_completed");
  await seedRun(stateHome, "run_active", "2026-06-01T00:00:00.000Z");

  const result = await pruneCueLineRuns({
    home: stateHome,
    olderThanMs: 30 * DAY_MS,
    now: () => NOW,
  });

  assert.equal(result.apply, false);
  assert.equal(result.prunedRuns, 0);
  assert.equal(result.eligibleRuns, 1);
  const byRun = new Map(result.decisions.map((entry) => [entry.runId, entry]));
  assert.equal(byRun.get("run_old_done")?.decision, "eligible");
  assert.deepEqual(byRun.get("run_fresh_done"), {
    runId: "run_fresh_done",
    decision: "kept",
    reason: "too_recent",
    status: "complete",
    lastEventAt: "2026-07-16T00:00:00.000Z",
  });
  assert.equal(byRun.get("run_active")?.reason, "non_terminal");
  assert.equal(await exists(runPaths(stateHome, "run_old_done").runDir), true);
});

test("apply deletes eligible runs and their job records and is idempotent", async () => {
  const stateHome = await home();
  await seedRun(stateHome, "run_old_done", "2026-06-01T00:00:00.000Z", "run_completed");
  await seedRun(stateHome, "run_old_blocked", "2026-06-01T00:00:00.000Z", "run_blocked");
  await seedRun(stateHome, "run_keep", "2026-06-01T00:00:00.000Z");
  const jobs = new JobStatusStore(stateHome);
  await jobs.write({
    jobId: "job_pruned",
    runId: "run_old_done",
    execution: "foreground",
    status: "succeeded",
    startedAt: "2026-06-01T00:00:00.000Z",
    finishedAt: "2026-06-01T00:01:00.000Z",
  });
  await jobs.write({
    jobId: "job_kept",
    runId: "run_keep",
    execution: "foreground",
    status: "succeeded",
    startedAt: "2026-06-01T00:00:00.000Z",
    finishedAt: "2026-06-01T00:01:00.000Z",
  });

  const result = await pruneCueLineRuns({
    home: stateHome,
    olderThanMs: 30 * DAY_MS,
    apply: true,
    now: () => NOW,
  });

  assert.equal(result.prunedRuns, 2);
  assert.equal(result.removedJobRecords, 1);
  assert.deepEqual(result.errors, []);
  assert.equal(await exists(runPaths(stateHome, "run_old_done").runDir), false);
  assert.equal(await exists(runPaths(stateHome, "run_old_blocked").runDir), false);
  assert.equal(await exists(runPaths(stateHome, "run_keep").runDir), true);
  assert.equal(await jobs.read("job_pruned"), undefined);
  assert.notEqual(await jobs.read("job_kept"), undefined);

  const again = await pruneCueLineRuns({
    home: stateHome,
    olderThanMs: 30 * DAY_MS,
    apply: true,
    now: () => NOW,
  });
  assert.equal(again.prunedRuns, 0);
  assert.equal(again.removedJobRecords, 0);
});

test("state filters, active leases, unreadable runs, and symlinks are protected", async () => {
  const stateHome = await home();
  await seedRun(stateHome, "run_cancelled", "2026-06-01T00:00:00.000Z", "run_cancelled");
  await seedRun(stateHome, "run_completed", "2026-06-01T00:00:00.000Z", "run_completed");
  await seedRun(stateHome, "run_leased", "2026-06-01T00:00:00.000Z", "run_completed");
  await writeFile(
    runPaths(stateHome, "run_leased").runtimeLease,
    `${JSON.stringify({
      protocol: "cueline/runtime-lease/0.1",
      run_id: "run_leased",
      owner_id: "owner_prune_test",
      pid: "shared-runtime",
      state: "active",
      claimed_at: NOW.toISOString(),
      heartbeat_at: NOW.toISOString(),
    })}\n`,
    "utf8",
  );
  const runsDir = path.join(stateHome, "runs");
  await mkdir(path.join(runsDir, "run_corrupt"), { recursive: true });
  await symlink(
    runPaths(stateHome, "run_completed").runDir,
    path.join(runsDir, "run_symlink"),
  );

  const result = await pruneCueLineRuns({
    home: stateHome,
    olderThanMs: 30 * DAY_MS,
    states: ["cancelled"],
    apply: true,
    now: () => NOW,
  });

  const byRun = new Map(result.decisions.map((entry) => [entry.runId, entry]));
  assert.equal(byRun.get("run_cancelled")?.decision, "pruned");
  assert.equal(byRun.get("run_completed")?.reason, "state_excluded");
  assert.equal(byRun.get("run_corrupt")?.reason, "unreadable");
  assert.equal(byRun.has("run_symlink"), false);
  assert.equal(await exists(runPaths(stateHome, "run_cancelled").runDir), false);
  assert.equal(await exists(runPaths(stateHome, "run_completed").runDir), true);
  assert.equal(await exists(path.join(runsDir, "run_corrupt")), true);
  assert.equal(await exists(path.join(runsDir, "run_symlink")), true);

  const leaseGuard = await pruneCueLineRuns({
    home: stateHome,
    olderThanMs: 30 * DAY_MS,
    apply: true,
    now: () => NOW,
  });
  const guarded = leaseGuard.decisions.find((entry) => entry.runId === "run_leased");
  assert.equal(guarded?.decision, "kept");
  assert.equal(guarded?.reason, "runtime_active");
  assert.equal(await exists(runPaths(stateHome, "run_leased").runDir), true);
});

test("a run whose fence generation exists is still prunable", async () => {
  const stateHome = await home();
  await seedRun(stateHome, "run_fenced", "2026-06-01T00:00:00.000Z", "run_completed");
  const lease = await RuntimeLease.claim({ home: stateHome, runId: "run_fenced" });
  await lease.release();

  const result = await pruneCueLineRuns({
    home: stateHome,
    olderThanMs: 30 * DAY_MS,
    apply: true,
    now: () => NOW,
  });

  assert.deepEqual(result.errors, []);
  assert.equal(
    result.decisions.find((entry) => entry.runId === "run_fenced")?.decision,
    "pruned",
  );
  assert.equal(await exists(runPaths(stateHome, "run_fenced").runDir), false);
});

test("a lease claimed while prune waits on the mutation lock survives", async () => {
  const stateHome = await home();
  await seedRun(stateHome, "run_raced", "2026-06-01T00:00:00.000Z", "run_completed");
  const nowReal = new Date();

  const holder = withRuntimeLeaseMutation(stateHome, "run_raced", async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await writeFile(
      runPaths(stateHome, "run_raced").runtimeLease,
      `${JSON.stringify({
        protocol: "cueline/runtime-lease/0.1",
        run_id: "run_raced",
        owner_id: "owner_race_test",
        pid: "shared-runtime",
        state: "active",
        claimed_at: nowReal.toISOString(),
        heartbeat_at: nowReal.toISOString(),
      })}\n`,
      "utf8",
    );
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const pruning = pruneCueLineRuns({
    home: stateHome,
    olderThanMs: 30 * DAY_MS,
    apply: true,
  });
  const [, result] = await Promise.all([holder, pruning]);

  const decision = result.decisions.find((entry) => entry.runId === "run_raced");
  assert.equal(decision?.decision, "kept");
  assert.equal(decision?.reason, "runtime_active");
  assert.equal(await exists(runPaths(stateHome, "run_raced").runDir), true);
});

test("the CLI wires dry-run, apply, and usage validation", async () => {
  const stateHome = await home();
  await seedRun(stateHome, "run_old_done", "2026-06-01T00:00:00.000Z", "run_completed");
  const environment = { CUELINE_HOME: stateHome, HOME: stateHome };

  const dry = collectingIo();
  assert.equal(await main(["runs", "prune", "--json"], environment, dry.io), 0);
  const dryReport = JSON.parse(dry.lines.join("\n")) as {
    apply: boolean;
    eligibleRuns: number;
    prunedRuns: number;
  };
  assert.equal(dryReport.apply, false);
  assert.equal(dryReport.eligibleRuns, 1);
  assert.equal(dryReport.prunedRuns, 0);
  assert.doesNotMatch(dry.lines.join("\n"), /PRIVATE REQUEST/);

  const applied = collectingIo();
  assert.equal(
    await main(
      ["runs", "prune", "--older-than-days", "30", "--apply"],
      environment,
      applied.io,
    ),
    0,
  );
  assert.match(applied.lines.join("\n"), /run\trun_old_done\tpruned/);
  assert.equal(await exists(runPaths(stateHome, "run_old_done").runDir), false);

  const badState = collectingIo();
  assert.equal(
    await main(["runs", "prune", "--state", "running"], environment, badState.io),
    2,
  );
  const badDays = collectingIo();
  assert.equal(
    await main(["runs", "prune", "--older-than-days", "-1"], environment, badDays.io),
    2,
  );
});
