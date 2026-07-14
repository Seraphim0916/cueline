import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CueLineError } from "../../src/core/errors.js";
import { runPaths } from "../../src/state/paths.js";
import { readRuntimeLease, RuntimeLease } from "../../src/state/runtime-lease.js";

test("runtime lease proves active ownership, rejects a second owner, and exposes staleness", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-lease-"));
  const runId = "run_lease_test";
  await mkdir(runPaths(home, runId).runDir, { recursive: true });
  const claimedAt = new Date("2026-07-15T00:00:00.000Z");
  const lease = await RuntimeLease.claim({
    home,
    runId,
    now: () => claimedAt,
    heartbeatIntervalMs: 60_000,
  });

  assert.equal(
    (await readRuntimeLease(home, runId, { now: () => claimedAt })).ownership,
    "active",
  );
  await assert.rejects(
    RuntimeLease.claim({ home, runId, now: () => claimedAt }),
    (error: unknown) => error instanceof CueLineError && error.code === "RUN_ALREADY_ACTIVE",
  );
  assert.equal(
    (
      await readRuntimeLease(home, runId, {
        now: () => new Date(claimedAt.getTime() + 20_001),
      })
    ).ownership,
    "stale",
  );

  await lease.release();
  assert.equal((await readRuntimeLease(home, runId)).ownership, "released");
});
