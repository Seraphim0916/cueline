import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  listCueLineRuns,
  loadCueLineRunStatus,
  pruneCueLineRuns,
  startCueLineRun,
} from "../../src/api.js";
import { runPaths } from "../../src/state/paths.js";

// A fixed clock keeps loadCueLineRunStatus / listCueLineRuns byte-identical
// across the before/after comparison, so any difference can only come from the
// injected crash artifacts rather than elapsed wall-clock time.
const FIXED_NOW = (): Date => new Date("2026-07-19T00:00:00.000Z");

async function environmentFor(home: string): Promise<NodeJS.ProcessEnv> {
  return {
    ...process.env,
    CUELINE_HOME: home,
    CUELINE_CONFIG: path.resolve("config/routing.default.json"),
  };
}

test("crash-artifact temp files beside a run's durable state are ignored by every read path", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-crash-orphan-"));
  const environment = await environmentFor(home);
  const started = await startCueLineRun({
    request: "durable run for crash-orphan characterization",
    runId: "run_crash_orphan",
    home,
    environment,
  });

  const readState = async (): Promise<{
    status: Awaited<ReturnType<typeof loadCueLineRunStatus>>;
    list: Awaited<ReturnType<typeof listCueLineRuns>>;
  }> => ({
    status: await loadCueLineRunStatus(started.runId, { home, environment, now: FIXED_NOW }),
    list: await listCueLineRuns({ home, environment, now: FIXED_NOW }),
  });

  const before = await readState();
  assert.equal(before.list.length, 1);
  assert.equal(before.list[0]?.readable, true);

  // Simulate an unclean crash mid atomic-write / event-append: the durable
  // targets (snapshot.json, events.jsonl) are intact but orphan temporaries
  // were left beside them. The names mirror the writers exactly — atomic-write.ts
  // uses `.<basename>.<pidTag>.<uuid>.tmp`, event-log.ts uses `.creating-<uuid>.tmp`.
  const paths = runPaths(home, started.runId);
  const runsRoot = path.join(home, "runs");
  const orphans = [
    path.join(paths.runDir, ".snapshot.json.pid-424242.11111111-1111-1111-1111-111111111111.tmp"),
    path.join(paths.runDir, ".events.jsonl.pid-424242.22222222-2222-2222-2222-222222222222.tmp"),
    path.join(paths.runDir, ".runtime.json.pid-424242.33333333-3333-3333-3333-333333333333.tmp"),
    path.join(paths.runDir, ".creating-44444444-4444-4444-4444-444444444444.tmp"),
    // Stray entries directly under runs/: a non-directory can never be a run.
    path.join(runsRoot, ".DS_Store"),
    path.join(runsRoot, "stray-not-a-run.tmp"),
  ];
  for (const orphan of orphans) {
    await writeFile(orphan, "{ partially-written crash artifact", "utf8");
  }

  const after = await readState();

  // Reading is oblivious to the orphans: identical status and identical listing.
  assert.deepEqual(after.status, before.status);
  assert.deepEqual(after.list, before.list);
  assert.equal(after.list.length, 1);
  assert.equal(after.list[0]?.readable, true);

  // A dry-run prune walks the whole runs tree; it must see exactly the one real
  // run and never trip over the orphan temporaries.
  const prune = await pruneCueLineRuns({
    olderThanMs: 0,
    apply: false,
    home,
    environment,
    now: FIXED_NOW,
  });
  assert.equal(prune.decisions.length, 1);
  assert.equal(prune.decisions[0]?.runId, started.runId);
  assert.equal(prune.prunedRuns, 0);

  // Reads are non-destructive: the orphan artifacts are still on disk (cleanup
  // is a separate concern, not something a read path may silently perform).
  const remaining = new Set(await readdir(paths.runDir));
  assert.equal(remaining.has(".creating-44444444-4444-4444-4444-444444444444.tmp"), true);
  assert.equal(
    remaining.has(".snapshot.json.pid-424242.11111111-1111-1111-1111-111111111111.tmp"),
    true,
  );
  assert.equal(remaining.has("snapshot.json"), true);
  assert.equal(remaining.has("events.jsonl"), true);
});
