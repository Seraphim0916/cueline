import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { listCueLineRuns } from "../../src/api.js";
import { initialRunState, reduceRunState } from "../../src/core/state-machine.js";
import { readEvents } from "../../src/state/event-log.js";
import { runPaths } from "../../src/state/paths.js";
import { RunStore } from "../../src/state/store.js";

async function home(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "cueline-run-list-"));
}

async function seedRun(
  stateHome: string,
  runId: string,
  timestamp: string,
  terminal = false,
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
  if (terminal) {
    await store.append("run_completed", {
      final_delivery_text: `PRIVATE RESULT ${runId}`,
    });
  }
}

test("lists persisted runs newest-first without prompt, result, or conversation data", async () => {
  const stateHome = await home();
  await seedRun(stateHome, "run_older", "2026-07-15T01:00:00.000Z");
  await seedRun(stateHome, "run_newer", "2026-07-15T02:00:00.000Z", true);
  const before = await readEvents(runPaths(stateHome, "run_newer").events);

  const runs = await listCueLineRuns({ home: stateHome });

  assert.deepEqual(runs, [
    {
      runId: "run_newer",
      readable: true,
      status: "complete",
      executor: "caller",
      phase: "complete",
      round: 0,
      pendingTurns: 0,
      activeJobs: 0,
      runtimeOwnership: "missing",
      safeNextAction: "return_result",
      lastEventSequence: 2,
      lastEventAt: "2026-07-15T02:00:00.000Z",
    },
    {
      runId: "run_older",
      readable: true,
      status: "running",
      executor: "caller",
      phase: "starting",
      round: 0,
      pendingTurns: 0,
      activeJobs: 0,
      runtimeOwnership: "missing",
      safeNextAction: "continue",
      lastEventSequence: 1,
      lastEventAt: "2026-07-15T01:00:00.000Z",
    },
  ]);
  const serialized = JSON.stringify(runs);
  assert.doesNotMatch(serialized, /PRIVATE REQUEST|PRIVATE RESULT|conversation/i);
  assert.deepEqual(
    await readEvents(runPaths(stateHome, "run_newer").events),
    before,
    "inventory must not append or rewrite run evidence",
  );
});

test("isolates unreadable runs and ignores invalid directories and symlinks", async () => {
  const stateHome = await home();
  await seedRun(stateHome, "run_valid", "2026-07-15T03:00:00.000Z");
  const runsDir = path.join(stateHome, "runs");
  await mkdir(path.join(runsDir, "run_corrupt"), { recursive: true });
  await mkdir(path.join(runsDir, "not a run"), { recursive: true });
  await symlink(path.join(runsDir, "run_valid"), path.join(runsDir, "run_symlink"));

  const runs = await listCueLineRuns({ home: stateHome });

  assert.equal(runs.some((run) => run.runId === "run_valid" && run.readable), true);
  assert.deepEqual(
    runs.find((run) => run.runId === "run_corrupt"),
    { runId: "run_corrupt", readable: false, errorCode: "RUN_NOT_FOUND" },
  );
  assert.equal(runs.some((run) => run.runId === "not a run"), false);
  assert.equal(runs.some((run) => run.runId === "run_symlink"), false);
});

test("an absent runs directory is a valid empty inventory", async () => {
  assert.deepEqual(await listCueLineRuns({ home: await home() }), []);
});
