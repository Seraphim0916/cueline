import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CueLineError } from "../../src/core/errors.js";
import { readEvents } from "../../src/state/event-log.js";
import { runPaths } from "../../src/state/paths.js";
import {
  readRuntimeLease,
  readRuntimeOwnerRetirementCutoffs,
  retireDeadRuntimeLease,
  RuntimeLease,
} from "../../src/state/runtime-lease.js";
import { runtimeFenceAuthorityIdentity } from "../../src/state/runtime-retirement.js";

test("runtime fence authority changes when a generation commits from legacy to epoch", () => {
  const generation = "same-generation";
  assert.notEqual(
    runtimeFenceAuthorityIdentity({ generation, lease_source: "legacy" }),
    runtimeFenceAuthorityIdentity({ generation, lease_source: "epoch" }),
  );
});

test("malformed runtime lease identity and timestamps are invalid, never stale", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-invalid-lease-record-"));
  const runId = "run_invalid_lease_record";
  const paths = runPaths(home, runId);
  await mkdir(paths.runDir, { recursive: true });
  const timestamp = "2026-07-15T00:00:00.000Z";
  const valid = {
    protocol: "cueline/runtime-lease/0.1",
    run_id: runId,
    owner_id: "durable-owner",
    pid: "shared-runtime",
    state: "active",
    claimed_at: timestamp,
    heartbeat_at: timestamp,
  };
  const malformed = [
    { ...valid, owner_id: "" },
    { ...valid, owner_id: " durable-owner " },
    { ...valid, pid: "" },
    { ...valid, pid: " shared-runtime " },
    { ...valid, claimed_at: "not-a-time" },
    { ...valid, claimed_at: "2026-07-15" },
    { ...valid, heartbeat_at: "not-a-time" },
    { ...valid, heartbeat_at: "2026-07-15T08:00:00+08:00" },
    {
      ...valid,
      retired_owners: [
        { owner_id: "old", events_after_sequence: 1, retired_at: "not-a-time" },
      ],
    },
    { ...valid, state: "released" },
    { ...valid, state: "released", released_at: "not-a-time" },
  ];

  for (const record of malformed) {
    await writeFile(paths.runtimeLease, `${JSON.stringify(record)}\n`, "utf8");
    assert.equal(
      (await readRuntimeLease(home, runId, { now: () => new Date(timestamp) })).ownership,
      "invalid",
    );
  }
});

test("a malformed runtime fence timestamp cannot authorize its epoch lease", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-invalid-fence-record-"));
  const runId = "run_invalid_fence_record";
  const paths = runPaths(home, runId);
  const generation = "invalid-fence-generation";
  const timestamp = "2026-07-15T00:00:00.000Z";
  await mkdir(`${paths.runtimeLease}.epochs`, { recursive: true });
  await writeFile(
    `${paths.runtimeLease}.fence`,
    `${JSON.stringify({
      protocol: "cueline/runtime-fence/0.1",
      run_id: runId,
      generation,
      created_at: "not-a-time",
      lease_source: "epoch",
    })}\n`,
    "utf8",
  );
  await writeFile(
    `${paths.runtimeLease}.epochs/${generation}.json`,
    `${JSON.stringify({
      protocol: "cueline/runtime-lease/0.1",
      run_id: runId,
      owner_id: "epoch-owner",
      pid: "shared-runtime",
      state: "active",
      claimed_at: timestamp,
      heartbeat_at: timestamp,
    })}\n`,
    "utf8",
  );

  assert.equal(
    (await readRuntimeLease(home, runId, { now: () => new Date(timestamp) })).ownership,
    "invalid",
  );
});

test("a runtime fence generation cannot escape the epoch directory", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-fence-path-escape-"));
  const runId = "run_fence_path_escape";
  const paths = runPaths(home, runId);
  const timestamp = "2026-07-15T00:00:00.000Z";
  await mkdir(`${paths.runtimeLease}.epochs`, { recursive: true });
  await writeFile(
    `${paths.runtimeLease}.fence`,
    `${JSON.stringify({
      protocol: "cueline/runtime-fence/0.1",
      run_id: runId,
      generation: "../escaped",
      created_at: timestamp,
      lease_source: "epoch",
    })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(paths.runDir, "escaped.json"),
    `${JSON.stringify({
      protocol: "cueline/runtime-lease/0.1",
      run_id: runId,
      owner_id: "outside-epoch-owner",
      pid: "shared-runtime",
      state: "active",
      claimed_at: timestamp,
      heartbeat_at: timestamp,
    })}\n`,
    "utf8",
  );

  assert.equal(
    (await readRuntimeLease(home, runId, { now: () => new Date(timestamp) })).ownership,
    "invalid",
  );
});

async function ageRuntimeMutationLock(home: string, runId: string): Promise<void> {
  const lockDirectory = `${runPaths(home, runId).runtimeLease}.lock`;
  const entries = await readdir(lockDirectory);
  const old = new Date(Date.now() - 60_000);
  if (entries.length === 0) {
    await utimes(lockDirectory, old, old);
    return;
  }
  for (const entry of entries) await utimes(`${lockDirectory}/${entry}`, old, old);
}

test("runtime lease rejects unsafe heartbeat timer values before creating ownership", async () => {
  for (const heartbeatIntervalMs of [
    0,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2_147_483_648,
  ]) {
    const home = await mkdtemp(path.join(tmpdir(), "cueline-invalid-heartbeat-"));
    const runId = "run_invalid_heartbeat";
    await mkdir(runPaths(home, runId).runDir, { recursive: true });

    await assert.rejects(
      RuntimeLease.claim({ home, runId, heartbeatIntervalMs }),
      (error: unknown) =>
        error instanceof CueLineError &&
        error.code === "RUNTIME_HEARTBEAT_INTERVAL_INVALID",
      String(heartbeatIntervalMs),
    );
    assert.equal((await readRuntimeLease(home, runId)).ownership, "missing");
  }
});

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
  assert.equal((await readRuntimeLease(home, runId)).ownership, "missing");
});

test("runtime lease serializes concurrent claimers after release", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-lease-race-"));
  const runId = "run_lease_race";
  await mkdir(runPaths(home, runId).runDir, { recursive: true });
  const original = await RuntimeLease.claim({ home, runId, heartbeatIntervalMs: 60_000 });
  await original.release();

  const claims = await Promise.allSettled([
    RuntimeLease.claim({ home, runId, heartbeatIntervalMs: 60_000 }),
    RuntimeLease.claim({ home, runId, heartbeatIntervalMs: 60_000 }),
  ]);
  const winners = claims.filter(
    (result): result is PromiseFulfilledResult<RuntimeLease> => result.status === "fulfilled",
  );
  const losers = claims.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );

  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(losers[0]?.reason instanceof CueLineError, true);
  await winners[0]?.value.release();
});

test("runtime lease migrates a legacy released record with one concurrent winner", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-released-race-"));
  const runId = "run_released_race";
  const paths = runPaths(home, runId);
  await mkdir(paths.runDir, { recursive: true });
  const timestamp = "2026-07-15T00:00:00.000Z";
  await writeFile(
    paths.runtimeLease,
    `${JSON.stringify({
      protocol: "cueline/runtime-lease/0.1",
      run_id: runId,
      owner_id: "legacy-released-owner",
      pid: "2147483647",
      state: "released",
      claimed_at: timestamp,
      heartbeat_at: timestamp,
      released_at: timestamp,
    })}\n`,
    "utf8",
  );

  const claims = await Promise.allSettled([
    RuntimeLease.claim({ home, runId, heartbeatIntervalMs: 60_000 }),
    RuntimeLease.claim({ home, runId, heartbeatIntervalMs: 60_000 }),
  ]);
  const winners = claims.filter(
    (result): result is PromiseFulfilledResult<RuntimeLease> => result.status === "fulfilled",
  );

  assert.equal(winners.length, 1);
  assert.equal((await readRuntimeLease(home, runId)).ownership, "active");
  await winners[0]?.value.release();
});

test("concurrent dead-owner retirement has exactly one winner", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-retire-race-"));
  const runId = "run_retire_race";
  const paths = runPaths(home, runId);
  await mkdir(paths.runDir, { recursive: true });
  const timestamp = new Date().toISOString();
  await writeFile(
    paths.runtimeLease,
    `${JSON.stringify({
      protocol: "cueline/runtime-lease/0.1",
      run_id: runId,
      owner_id: "dead-owner",
      pid: "2147483647",
      state: "active",
      claimed_at: timestamp,
      heartbeat_at: timestamp,
    })}\n`,
    "utf8",
  );

  const results = await Promise.allSettled([
    retireDeadRuntimeLease(home, runId, "dead-owner"),
    retireDeadRuntimeLease(home, runId, "dead-owner"),
  ]);
  const retired = results.filter(
    (result): result is PromiseFulfilledResult<boolean> =>
      result.status === "fulfilled" && result.value,
  );

  assert.equal(retired.length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 0);
  assert.equal((await readRuntimeLease(home, runId)).ownership, "missing");
});

test("stale retirement contenders cannot steal a newly claimed live owner", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-retire-new-owner-race-"));
  const runId = "run_retire_new_owner_race";
  const paths = runPaths(home, runId);
  await mkdir(paths.runDir, { recursive: true });
  const timestamp = new Date().toISOString();
  await writeFile(
    paths.runtimeLease,
    `${JSON.stringify({
      protocol: "cueline/runtime-lease/0.1",
      run_id: runId,
      owner_id: "old-dead-owner",
      pid: "2147483647",
      state: "active",
      claimed_at: timestamp,
      heartbeat_at: timestamp,
    })}\n`,
    "utf8",
  );

  const retirements = Array.from({ length: 4 }, () =>
    retireDeadRuntimeLease(home, runId, "old-dead-owner"),
  );
  const claim = (async (): Promise<RuntimeLease> => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      try {
        return await RuntimeLease.claim({
          home,
          runId,
          heartbeatIntervalMs: 60_000,
        });
      } catch (error) {
        if (
          !(error instanceof CueLineError) ||
          (error.code !== "RUN_ALREADY_ACTIVE" &&
            error.code !== "RUN_CLAIM_IN_PROGRESS")
        ) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    }
    throw new Error("new owner never acquired the retired lease");
  })();

  const lease = await claim;
  await Promise.all(retirements);
  const lateRetirements = await Promise.all(
    Array.from({ length: 4 }, () =>
      retireDeadRuntimeLease(home, runId, "old-dead-owner"),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(lateRetirements, Array.from({ length: 4 }, () => false));
  assert.equal(lease.signal.aborted, false);
  assert.equal((await readRuntimeLease(home, runId)).ownership, "active");
  assert.equal(
    (await readdir(paths.runDir)).some((entry) => entry.includes(".retired.")),
    false,
  );
  await lease.release();
});

test("explicit stale takeover atomically replaces a non-numeric live-host owner with exact evidence", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-stale-takeover-"));
  const runId = "run_stale_takeover";
  const paths = runPaths(home, runId);
  await mkdir(paths.runDir, { recursive: true });
  const heartbeatAt = "2026-07-15T00:00:00.000Z";
  await writeFile(
    paths.runtimeLease,
    `${JSON.stringify({
      protocol: "cueline/runtime-lease/0.1",
      run_id: runId,
      owner_id: "shared-node-repl-owner",
      pid: "repl-shared-host",
      state: "active",
      claimed_at: heartbeatAt,
      heartbeat_at: heartbeatAt,
    })}\n`,
    "utf8",
  );
  const now = () => new Date("2026-07-15T00:01:00.000Z");

  assert.equal(
    await retireDeadRuntimeLease(home, runId, "shared-node-repl-owner"),
    false,
  );
  await assert.rejects(
    RuntimeLease.takeoverStale({
      home,
      runId,
      expectedOwnerId: "shared-node-repl-owner",
      expectedHeartbeatAt: "2026-07-15T00:00:01.000Z",
      now,
    }),
    (error: unknown) =>
      error instanceof CueLineError && error.code === "RUNTIME_TAKEOVER_RACE",
  );
  const observations: string[] = [];
  const lease = await RuntimeLease.takeoverStale({
    home,
    runId,
    expectedOwnerId: "shared-node-repl-owner",
    expectedHeartbeatAt: heartbeatAt,
    now,
    heartbeatIntervalMs: 60_000,
    beforeReplace: async () => {
      observations.push((await readRuntimeLease(home, runId, { now })).ownership);
    },
  });
  assert.deepEqual(observations, ["stale"]);
  const replacement = await readRuntimeLease(home, runId, { now });
  assert.equal(replacement.ownership, "active");
  assert.notEqual(replacement.ownerId, "shared-node-repl-owner");
  await lease.release();
});

test("invalid takeover heartbeat timing cannot append intent or replace the stale owner", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-invalid-takeover-timer-"));
  const runId = "run_invalid_takeover_timer";
  const paths = runPaths(home, runId);
  await mkdir(paths.runDir, { recursive: true });
  const heartbeatAt = "2026-07-15T00:00:00.000Z";
  await writeFile(
    paths.runtimeLease,
    `${JSON.stringify({
      protocol: "cueline/runtime-lease/0.1",
      run_id: runId,
      owner_id: "stale-owner",
      pid: "remote-owner",
      state: "active",
      claimed_at: heartbeatAt,
      heartbeat_at: heartbeatAt,
    })}\n`,
    "utf8",
  );

  await assert.rejects(
    RuntimeLease.takeoverStale({
      home,
      runId,
      expectedOwnerId: "stale-owner",
      expectedHeartbeatAt: heartbeatAt,
      now: () => new Date("2026-07-15T00:01:00.000Z"),
      heartbeatIntervalMs: 2_147_483_648,
    }),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "RUNTIME_HEARTBEAT_INTERVAL_INVALID",
  );

  const observation = await readRuntimeLease(home, runId, {
    now: () => new Date("2026-07-15T00:01:00.000Z"),
  });
  assert.equal(observation.ownership, "stale");
  assert.equal(observation.ownerId, "stale-owner");
  assert.equal(
    (await readdir(paths.runDir)).some((entry) => entry.includes("takeover-intents")),
    false,
  );
});

test("explicit stale takeover refuses an active heartbeat and has one atomic concurrent winner", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-stale-takeover-race-"));
  const runId = "run_stale_takeover_race";
  const paths = runPaths(home, runId);
  await mkdir(paths.runDir, { recursive: true });
  const heartbeatAt = "2026-07-15T00:00:00.000Z";
  await writeFile(
    paths.runtimeLease,
    `${JSON.stringify({
      protocol: "cueline/runtime-lease/0.1",
      run_id: runId,
      owner_id: "live-host-owner",
      pid: String(process.pid),
      state: "active",
      claimed_at: heartbeatAt,
      heartbeat_at: heartbeatAt,
    })}\n`,
    "utf8",
  );

  await assert.rejects(
    RuntimeLease.takeoverStale({
      home,
      runId,
      expectedOwnerId: "live-host-owner",
      expectedHeartbeatAt: heartbeatAt,
      now: () => new Date("2026-07-15T00:00:10.000Z"),
    }),
    (error: unknown) =>
      error instanceof CueLineError && error.code === "RUNTIME_TAKEOVER_ACTIVE_REFUSED",
  );
  const attempts = await Promise.allSettled([
    RuntimeLease.takeoverStale({
      home,
      runId,
      expectedOwnerId: "live-host-owner",
      expectedHeartbeatAt: heartbeatAt,
      now: () => new Date("2026-07-15T00:01:00.000Z"),
      heartbeatIntervalMs: 60_000,
    }),
    RuntimeLease.takeoverStale({
      home,
      runId,
      expectedOwnerId: "live-host-owner",
      expectedHeartbeatAt: heartbeatAt,
      now: () => new Date("2026-07-15T00:01:00.000Z"),
      heartbeatIntervalMs: 60_000,
    }),
  ]);
  const winners = attempts.filter(
    (result): result is PromiseFulfilledResult<RuntimeLease> => result.status === "fulfilled",
  );
  assert.equal(winners.length, 1);
  assert.equal(attempts.filter((result) => result.status === "rejected").length, 1);
  assert.equal(
    (
      await readRuntimeLease(home, runId, {
        now: () => new Date("2026-07-15T00:01:00.000Z"),
      })
    ).ownership,
    "active",
  );
  await winners[0]?.value.release();
});

test("rejected legacy lease mutations keep the live 0.1.3 heartbeat authoritative", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-legacy-rejection-authority-"));
  const runId = "run_legacy_rejection_authority";
  const paths = runPaths(home, runId);
  await mkdir(paths.runDir, { recursive: true });
  const initialHeartbeat = "2026-07-15T00:00:00.000Z";
  const legacyLease = (heartbeatAt: string) => ({
    protocol: "cueline/runtime-lease/0.1",
    run_id: runId,
    owner_id: "legacy-013-owner",
    pid: "shared-node-repl",
    state: "active",
    claimed_at: initialHeartbeat,
    heartbeat_at: heartbeatAt,
  });
  await writeFile(paths.runtimeLease, `${JSON.stringify(legacyLease(initialHeartbeat))}\n`, "utf8");

  await assert.rejects(
    RuntimeLease.takeoverStale({
      home,
      runId,
      expectedOwnerId: "legacy-013-owner",
      expectedHeartbeatAt: initialHeartbeat,
      now: () => new Date("2026-07-15T00:00:10.000Z"),
    }),
    (error: unknown) =>
      error instanceof CueLineError && error.code === "RUNTIME_TAKEOVER_ACTIVE_REFUSED",
  );
  await assert.rejects(
    RuntimeLease.claim({
      home,
      runId,
      now: () => new Date("2026-07-15T00:00:10.000Z"),
    }),
    (error: unknown) => error instanceof CueLineError && error.code === "RUN_ALREADY_ACTIVE",
  );
  assert.equal(await retireDeadRuntimeLease(home, runId, "legacy-013-owner"), false);
  await assert.rejects(readFile(`${paths.runtimeLease}.fence`, "utf8"), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT",
  );

  const refreshedHeartbeat = "2026-07-15T00:00:15.000Z";
  await writeFile(paths.runtimeLease, `${JSON.stringify(legacyLease(refreshedHeartbeat))}\n`, "utf8");
  const observation = await readRuntimeLease(home, runId, {
    now: () => new Date("2026-07-15T00:00:25.000Z"),
  });
  assert.equal(observation.ownership, "active");
  assert.equal(observation.heartbeatAt, refreshedHeartbeat);
});

test("legacy JSONL suffixes after takeover stay auditable but outside authoritative replay", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-legacy-event-takeover-"));
  const runId = "run_legacy_event_takeover";
  const paths = runPaths(home, runId);
  await mkdir(paths.runDir, { recursive: true });
  const heartbeatAt = "2026-07-15T00:00:00.000Z";
  await writeFile(
    paths.events,
    `${JSON.stringify({
      sequence: 1,
      timestamp: heartbeatAt,
      type: "run_created",
      payload: { request: "legacy event cutoff" },
    })}\n`,
    "utf8",
  );
  await writeFile(
    paths.runtimeLease,
    `${JSON.stringify({
      protocol: "cueline/runtime-lease/0.1",
      run_id: runId,
      owner_id: "legacy-013-owner",
      pid: "shared-node-repl",
      state: "active",
      claimed_at: heartbeatAt,
      heartbeat_at: heartbeatAt,
    })}\n`,
    "utf8",
  );
  const lease = await RuntimeLease.takeoverStale({
    home,
    runId,
    expectedOwnerId: "legacy-013-owner",
    expectedHeartbeatAt: heartbeatAt,
    now: () => new Date("2026-07-15T00:01:00.000Z"),
    heartbeatIntervalMs: 60_000,
  });
  await appendFile(
    paths.events,
    `${JSON.stringify({
      sequence: 2,
      timestamp: "2026-07-15T00:01:00.001Z",
      type: "legacy_late_after_takeover",
      payload: { must_not_replay: true },
    })}\n`,
    "utf8",
  );

  assert.deepEqual((await readEvents(paths.events)).map((event) => event.type), ["run_created"]);
  const raw = await readFile(paths.events, "utf8");
  assert.match(raw, /legacy_late_after_takeover/);
  await lease.release();
  assert.deepEqual((await readEvents(paths.events)).map((event) => event.type), ["run_created"]);
});

test("retirement cutoff readers do not lose embedded evidence during release", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-retirement-release-race-"));
  const runId = "run_retirement_release_race";
  const paths = runPaths(home, runId);
  await mkdir(paths.runDir, { recursive: true });
  const heartbeatAt = "2026-07-15T00:00:00.000Z";
  await writeFile(
    paths.events,
    `${JSON.stringify({
      sequence: 1,
      timestamp: heartbeatAt,
      type: "run_created",
      payload: {},
    })}\n`,
    "utf8",
  );
  const inherited = Array.from({ length: 64 }, (_, index) => ({
    owner_id: `retired-owner-${index}`,
    events_after_sequence: index + 1,
    retired_at: heartbeatAt,
  }));
  await writeFile(
    paths.runtimeLease,
    `${JSON.stringify({
      protocol: "cueline/runtime-lease/0.1",
      run_id: runId,
      owner_id: "legacy-owner",
      pid: "shared-node-repl",
      state: "active",
      claimed_at: heartbeatAt,
      heartbeat_at: heartbeatAt,
      retired_owners: inherited,
    })}\n`,
    "utf8",
  );
  const lease = await RuntimeLease.takeoverStale({
    home,
    runId,
    expectedOwnerId: "legacy-owner",
    expectedHeartbeatAt: heartbeatAt,
    now: () => new Date("2026-07-15T00:01:00.000Z"),
    heartbeatIntervalMs: 60_000,
  });

  const releasing = lease.release();
  const observations = await Promise.all(
    Array.from({ length: 250 }, async () =>
      (await readRuntimeOwnerRetirementCutoffs(home, runId)).get("retired-owner-63"),
    ),
  );
  await releasing;
  assert.equal(observations.every((cutoff) => cutoff === 64), true);
  assert.equal(
    (await readRuntimeOwnerRetirementCutoffs(home, runId)).get("retired-owner-63"),
    64,
  );
});

test("stale takeover leaves the original owner intact when the durable pre-replacement audit fails", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-stale-takeover-audit-fail-"));
  const runId = "run_stale_takeover_audit_fail";
  const paths = runPaths(home, runId);
  await mkdir(paths.runDir, { recursive: true });
  const heartbeatAt = "2026-07-15T00:00:00.000Z";
  await writeFile(
    paths.runtimeLease,
    `${JSON.stringify({
      protocol: "cueline/runtime-lease/0.1",
      run_id: runId,
      owner_id: "original-owner",
      pid: "shared-host",
      state: "active",
      claimed_at: heartbeatAt,
      heartbeat_at: heartbeatAt,
    })}\n`,
    "utf8",
  );

  await assert.rejects(
    RuntimeLease.takeoverStale({
      home,
      runId,
      expectedOwnerId: "original-owner",
      expectedHeartbeatAt: heartbeatAt,
      now: () => new Date("2026-07-15T00:01:00.000Z"),
      beforeReplace: async () => {
        throw new Error("audit fsync failed");
      },
    }),
    /audit fsync failed/,
  );
  const observation = await readRuntimeLease(home, runId, {
    now: () => new Date("2026-07-15T00:01:00.000Z"),
  });
  assert.equal(observation.ownership, "stale");
  assert.equal(observation.ownerId, "original-owner");
  assert.equal(
    (await readRuntimeOwnerRetirementCutoffs(home, runId)).has("original-owner"),
    false,
  );
});

test("a stale empty mutation lock left between mkdir and owner-token creation is recoverable", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-empty-lock-recovery-"));
  const runId = "run_empty_lock_recovery";
  const paths = runPaths(home, runId);
  await mkdir(paths.runDir, { recursive: true });
  await mkdir(`${paths.runtimeLease}.lock`);
  await ageRuntimeMutationLock(home, runId);

  const lease = await RuntimeLease.claim({
    home,
    runId,
    heartbeatIntervalMs: 60_000,
  });

  assert.equal((await readRuntimeLease(home, runId)).ownership, "active");
  await lease.release();
  assert.equal((await readRuntimeLease(home, runId)).ownership, "missing");
});

test("fencing prevents a paused pre-replacement takeover from overwriting a reclaimer", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-fenced-pre-replace-"));
  const runId = "run_fenced_pre_replace";
  const paths = runPaths(home, runId);
  await mkdir(paths.runDir, { recursive: true });
  const heartbeatAt = "2026-07-15T00:00:00.000Z";
  await writeFile(
    paths.runtimeLease,
    `${JSON.stringify({
      protocol: "cueline/runtime-lease/0.1",
      run_id: runId,
      owner_id: "original-owner",
      pid: "shared-host",
      state: "active",
      claimed_at: heartbeatAt,
      heartbeat_at: heartbeatAt,
    })}\n`,
    "utf8",
  );
  let entered!: () => void;
  let resume!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resumePromise = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const paused = RuntimeLease.takeoverStale({
    home,
    runId,
    expectedOwnerId: "original-owner",
    expectedHeartbeatAt: heartbeatAt,
    now: () => new Date("2026-07-15T00:01:00.000Z"),
    heartbeatIntervalMs: 60_000,
    beforeReplace: async () => {
      entered();
      await resumePromise;
    },
  });
  await enteredPromise;
  await ageRuntimeMutationLock(home, runId);

  const winner = await RuntimeLease.takeoverStale({
    home,
    runId,
    expectedOwnerId: "original-owner",
    expectedHeartbeatAt: heartbeatAt,
    now: () => new Date("2026-07-15T00:02:00.000Z"),
    heartbeatIntervalMs: 60_000,
  });
  const winnerEvidence = await readRuntimeLease(home, runId, {
    now: () => new Date("2026-07-15T00:02:00.000Z"),
  });
  resume();
  await assert.rejects(
    paused,
    (error: unknown) =>
      error instanceof CueLineError && error.code === "RUNTIME_MUTATION_FENCED",
  );

  const afterLoserRelease = await readRuntimeLease(home, runId, {
    now: () => new Date("2026-07-15T00:02:00.000Z"),
  });
  assert.equal(afterLoserRelease.ownership, "active");
  assert.equal(afterLoserRelease.ownerId, winnerEvidence.ownerId);
  await winner.release();
});

test("fencing preserves a reclaimer when the prior takeover paused after replacement", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-fenced-post-replace-"));
  const runId = "run_fenced_post_replace";
  const paths = runPaths(home, runId);
  await mkdir(paths.runDir, { recursive: true });
  const heartbeatAt = "2026-07-15T00:00:00.000Z";
  await writeFile(
    paths.runtimeLease,
    `${JSON.stringify({
      protocol: "cueline/runtime-lease/0.1",
      run_id: runId,
      owner_id: "original-owner",
      pid: "shared-host",
      state: "active",
      claimed_at: heartbeatAt,
      heartbeat_at: heartbeatAt,
    })}\n`,
    "utf8",
  );
  let replaced!: () => void;
  let resume!: () => void;
  const replacedPromise = new Promise<void>((resolve) => {
    replaced = resolve;
  });
  const resumePromise = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const paused = RuntimeLease.takeoverStale({
    home,
    runId,
    expectedOwnerId: "original-owner",
    expectedHeartbeatAt: heartbeatAt,
    now: () => new Date("2026-07-15T00:01:00.000Z"),
    heartbeatIntervalMs: 60_000,
    afterReplace: async () => {
      replaced();
      await resumePromise;
    },
  });
  await replacedPromise;
  const pausedEvidence = await readRuntimeLease(home, runId, {
    now: () => new Date("2026-07-15T00:01:00.000Z"),
  });
  assert.equal(pausedEvidence.ownership, "active");
  await ageRuntimeMutationLock(home, runId);

  const winner = await RuntimeLease.takeoverStale({
    home,
    runId,
    expectedOwnerId: pausedEvidence.ownerId!,
    expectedHeartbeatAt: pausedEvidence.heartbeatAt!,
    now: () => new Date("2026-07-15T00:02:00.000Z"),
    heartbeatIntervalMs: 60_000,
  });
  const winnerEvidence = await readRuntimeLease(home, runId, {
    now: () => new Date("2026-07-15T00:02:00.000Z"),
  });
  resume();
  await assert.rejects(
    paused,
    (error: unknown) =>
      error instanceof CueLineError && error.code === "RUNTIME_MUTATION_FENCED",
  );

  const afterLoserRelease = await readRuntimeLease(home, runId, {
    now: () => new Date("2026-07-15T00:02:00.000Z"),
  });
  assert.equal(afterLoserRelease.ownership, "active");
  assert.equal(afterLoserRelease.ownerId, winnerEvidence.ownerId);
  await winner.release();
});

test("a live owner follows a reclaimed epoch and still releases its authoritative lease", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-owner-release-after-fence-"));
  const runId = "run_owner_release_after_fence";
  const paths = runPaths(home, runId);
  await mkdir(paths.runDir, { recursive: true });
  const lease = await RuntimeLease.claim({
    home,
    runId,
    heartbeatIntervalMs: 60_000,
  });
  await mkdir(`${paths.runtimeLease}.lock`);
  await writeFile(`${paths.runtimeLease}.lock/orphaned-owner`, "legacy lock\n", "utf8");
  await ageRuntimeMutationLock(home, runId);

  await lease.release();

  assert.equal((await readRuntimeLease(home, runId)).ownership, "missing");
});

test("runtime lease aborts owned work when heartbeat ownership becomes unreadable", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-lease-loss-"));
  const runId = "run_lease_loss";
  const paths = runPaths(home, runId);
  await mkdir(paths.runDir, { recursive: true });
  const lease = await RuntimeLease.claim({ home, runId, heartbeatIntervalMs: 5 });
  const fence = JSON.parse(await readFile(`${paths.runtimeLease}.fence`, "utf8")) as {
    generation: string;
  };
  await writeFile(
    `${paths.runtimeLease}.epochs/${fence.generation}.json`,
    "{}\n",
    "utf8",
  );

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("lease loss was not observed")), 500);
    lease.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

  assert.equal(lease.signal.aborted, true);
  assert.equal(
    lease.signal.reason instanceof CueLineError &&
      lease.signal.reason.code === "RUNTIME_LEASE_HEARTBEAT_FAILED",
    true,
  );
  await lease.release();
});
