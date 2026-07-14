import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalJson, commandHash, jobId, messageId } from "../../src/core/ids.js";
import { appendEvent, readEvents, type RunEvent } from "../../src/state/event-log.js";
import { defaultCueLineHome, runPaths } from "../../src/state/paths.js";
import { readRuntimeLease, RuntimeLease } from "../../src/state/runtime-lease.js";
import { RunStore } from "../../src/state/store.js";

interface CounterState {
  count: number;
  labels: string[];
}

function reduceCounter(state: CounterState, event: RunEvent): CounterState {
  if (event.type !== "increment") {
    return state;
  }
  const payload = event.payload as { amount: number; label: string };
  return {
    count: state.count + payload.amount,
    labels: [...state.labels, payload.label],
  };
}

test("canonical hashes ignore object key order but preserve arrays", () => {
  const left = { z: 1, nested: { b: true, a: "x" }, list: [2, 1] };
  const right = { list: [2, 1], nested: { a: "x", b: true }, z: 1 };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(commandHash(left), commandHash(right));
  assert.notEqual(commandHash(left), commandHash({ ...right, list: [1, 2] }));
});

test("deterministic job and message IDs are stable", () => {
  const spec = { lane: "triage", mode: "advise", task: "inspect" };
  assert.equal(jobId("run_1", "inspect", spec), jobId("run_1", "inspect", { ...spec }));
  assert.notEqual(jobId("run_1", "inspect", spec), jobId("run_1", "other", spec));
  assert.equal(
    messageId("run_1", 2, "controller", "hello"),
    messageId("run_1", 2, "controller", "hello"),
  );
});

test("event replay recovers when the materialized snapshot is corrupt", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-state-"));
  const options = {
    home,
    runId: "run_state_test",
    initialState: { count: 0, labels: [] } satisfies CounterState,
    reducer: reduceCounter,
  };

  const store = await RunStore.create(options);
  await store.append("increment", { amount: 2, label: "first" });
  await store.snapshot();
  await store.append("increment", { amount: 3, label: "second" });

  const paths = runPaths(home, options.runId);
  await writeFile(paths.snapshot, "{corrupt", "utf8");

  const loaded = await RunStore.load(options);
  assert.deepEqual(loaded.state, { count: 5, labels: ["first", "second"] });
  assert.equal(loaded.lastSequence, 2);

  assert.equal((await readEvents(paths.events)).length, 2);
  assert.deepEqual((await readdir(paths.runDir)).sort(), [
    "created",
    "events.jsonl.segments",
    "snapshot.json",
  ]);
  assert.ok(paths.runDir.startsWith(path.resolve(home) + path.sep));
});

test("concurrent stale RunStore instances append distinct ordered events", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-state-concurrent-"));
  const options = {
    home,
    runId: "run_state_concurrent",
    initialState: { count: 0, labels: [] } satisfies CounterState,
    reducer: reduceCounter,
  };
  const first = await RunStore.create(options);
  const second = await RunStore.load(options);

  await Promise.all([
    first.append("increment", { amount: 2, label: "first" }),
    second.append("increment", { amount: 3, label: "second" }),
  ]);

  const loaded = await RunStore.load(options);
  assert.equal(loaded.state.count, 5);
  assert.deepEqual(new Set(loaded.state.labels), new Set(["first", "second"]));
  assert.equal(loaded.lastSequence, 2);
  const lines = await readEvents(runPaths(home, options.runId).events);
  assert.deepEqual(lines.map((event) => event.sequence), [1, 2]);
});

test("an abandoned shared-host event lock cannot wedge lock-free segmented appends", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-state-abandoned-lock-"));
  const options = {
    home,
    runId: "run_state_abandoned_lock",
    initialState: { count: 0, labels: [] } satisfies CounterState,
    reducer: reduceCounter,
  };
  const store = await RunStore.create(options);
  const paths = runPaths(home, options.runId);
  await mkdir(`${paths.events}.lock`, { recursive: true });
  await writeFile(
    `${paths.events}.lock/owner-repl`,
    `${JSON.stringify({ pid: "repl-shared-host" })}\n`,
    "utf8",
  );

  await store.append("increment", { amount: 1, label: "not-wedged" });

  assert.deepEqual(store.state, { count: 1, labels: ["not-wedged"] });
  assert.equal((await readEvents(paths.events)).length, 1);
});

test("many independent writers claim complete event segments without duplicate sequences", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-state-many-writers-"));
  const options = {
    home,
    runId: "run_state_many_writers",
    initialState: { count: 0, labels: [] } satisfies CounterState,
    reducer: reduceCounter,
  };
  await RunStore.create(options);
  const writers = await Promise.all(
    Array.from({ length: 32 }, () => RunStore.load(options)),
  );

  await Promise.all(
    writers.map((writer, index) =>
      writer.append("increment", { amount: 1, label: `writer-${index}` }),
    ),
  );

  const events = await readEvents(runPaths(home, options.runId).events);
  assert.deepEqual(
    events.map((event) => event.sequence),
    Array.from({ length: 32 }, (_, index) => index + 1),
  );
  const loaded = await RunStore.load(options);
  assert.equal(loaded.state.count, 32);
  assert.equal(new Set(loaded.state.labels).size, 32);
});

test("stale runtime events after an exact takeover cutoff remain auditable but are ignored", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-state-owner-fence-"));
  const options = {
    home,
    runId: "run_state_owner_fence",
    initialState: { count: 0, labels: [] } satisfies CounterState,
    reducer: reduceCounter,
  };
  await RunStore.create(options);
  const claimedAt = new Date("2026-07-15T00:00:00.000Z");
  const oldLease = await RuntimeLease.claim({
    home,
    runId: options.runId,
    now: () => claimedAt,
    heartbeatIntervalMs: 60_000,
  });
  const oldStore = await RunStore.load(options);
  oldStore.bindRuntimeOwner(oldLease.ownerId);
  await oldStore.append("increment", { amount: 1, label: "before-cutoff" });

  const observed = await readRuntimeLease(home, options.runId, {
    now: () => new Date("2026-07-15T00:01:00.000Z"),
  });
  const winner = await RuntimeLease.takeoverStale({
    home,
    runId: options.runId,
    expectedOwnerId: observed.ownerId!,
    expectedHeartbeatAt: observed.heartbeatAt!,
    now: () => new Date("2026-07-15T00:01:00.000Z"),
    heartbeatIntervalMs: 60_000,
  });

  await appendEvent(runPaths(home, options.runId).events, {
    sequence: 2,
    timestamp: "2026-07-15T00:01:00.001Z",
    type: "increment",
    payload: { amount: 100, label: "stale-after-cutoff" },
    runtime_owner_id: oldLease.ownerId,
  });
  const loaded = await RunStore.load(options);
  assert.deepEqual(loaded.state, { count: 1, labels: ["before-cutoff"] });
  assert.equal(loaded.lastSequence, 2);
  await assert.rejects(
    oldStore.append("increment", { amount: 1000, label: "retired-writer" }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error.code === "EVENT_RUNTIME_OWNER_RETIRED" ||
        error.code === "EVENT_RUNTIME_OWNER_LOST"),
  );

  loaded.bindRuntimeOwner(winner.ownerId);
  await loaded.append("increment", { amount: 2, label: "winner" });
  assert.deepEqual(loaded.state, { count: 3, labels: ["before-cutoff", "winner"] });
  await oldLease.release();
  await winner.release();
});

test("takeover and runtime event append share one commit fence", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-state-takeover-commit-"));
  const options = {
    home,
    runId: "run_state_takeover_commit",
    initialState: { count: 0, labels: [] } satisfies CounterState,
    reducer: reduceCounter,
  };
  await RunStore.create(options);
  const oldLease = await RuntimeLease.claim({
    home,
    runId: options.runId,
    now: () => new Date("2026-07-15T00:00:00.000Z"),
    heartbeatIntervalMs: 60_000,
  });
  const oldStore = await RunStore.load(options);
  oldStore.bindRuntimeOwner(oldLease.ownerId);
  await oldStore.append("increment", { amount: 1, label: "committed-before-takeover" });
  const observed = await readRuntimeLease(home, options.runId, {
    now: () => new Date("2026-07-15T00:01:00.000Z"),
  });
  let entered!: () => void;
  let resume!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  const resumePromise = new Promise<void>((resolve) => { resume = resolve; });
  const takeover = RuntimeLease.takeoverStale({
    home,
    runId: options.runId,
    expectedOwnerId: observed.ownerId!,
    expectedHeartbeatAt: observed.heartbeatAt!,
    now: () => new Date("2026-07-15T00:01:00.000Z"),
    heartbeatIntervalMs: 60_000,
    beforeReplace: async () => {
      entered();
      await resumePromise;
    },
  });
  await enteredPromise;
  let appendSettled = false;
  const lateAppend = oldStore
    .append("increment", { amount: 100, label: "must-not-return-success" })
    .finally(() => { appendSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(appendSettled, false);
  resume();
  const winner = await takeover;
  await assert.rejects(
    lateAppend,
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error.code === "EVENT_RUNTIME_OWNER_RETIRED" ||
        error.code === "EVENT_RUNTIME_OWNER_LOST"),
  );
  const loaded = await RunStore.load(options);
  assert.deepEqual(loaded.state, { count: 1, labels: ["committed-before-takeover"] });
  await oldLease.release();
  await winner.release();
});

test("run IDs cannot escape CUELINE_HOME", () => {
  assert.throws(() => runPaths("/tmp/cueline", "../escape"), /RUN_ID_INVALID/);
});

test("default home expands under HOME without leaving a literal tilde", () => {
  assert.equal(
    defaultCueLineHome({ HOME: "/tmp/cueline-user" }),
    "/tmp/cueline-user/.cueline",
  );
  assert.equal(
    defaultCueLineHome({ HOME: "/tmp/cueline-user", CUELINE_HOME: "/var/tmp/custom" }),
    "/var/tmp/custom",
  );
});
