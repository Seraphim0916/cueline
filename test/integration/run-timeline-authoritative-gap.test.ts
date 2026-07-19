import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCueLineRunTimeline } from "../../src/observation/run-timeline.js";
import { appendEvent, type RunEvent } from "../../src/state/event-log.js";
import { runPaths } from "../../src/state/paths.js";
import { readRuntimeLease, RuntimeLease } from "../../src/state/runtime-lease.js";
import { RunStore, readAuthoritativeRunEvents } from "../../src/state/store.js";

function event(sequence: number, type: string): RunEvent {
  return {
    sequence,
    timestamp: `2026-07-15T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    type,
    payload: {},
  };
}

test("buildCueLineRunTimeline tolerates a mid-stream authoritative gap", () => {
  // readAuthoritativeRunEvents can drop a retired owner's event from the middle
  // of the log, leaving e.g. sequences [1, 3, 4]. The timeline must project it,
  // not reject it — this is exactly the run an operator needs to diagnose.
  const timeline = buildCueLineRunTimeline(
    "run_gap",
    [event(1, "run_created"), event(3, "controller_turn_requested"), event(4, "job_registered")],
    "/tmp/cueline-home",
  );

  assert.deepEqual(timeline.entries.map((entry) => entry.sequence), [1, 3, 4]);
  assert.equal(timeline.latestSequence, 4);
  assert.equal(timeline.totalEvents, 3);
  assert.equal(timeline.nextAfterSequence, 4);
  assert.equal(timeline.hasMore, false);
});

test("buildCueLineRunTimeline still rejects a non-increasing event sequence", () => {
  for (const sequences of [[1, 1], [2, 1], [1, 3, 3], [0, 1]]) {
    assert.throws(
      () =>
        buildCueLineRunTimeline(
          "run_gap",
          sequences.map((sequence) => event(sequence, "run_created")),
          "/tmp/cueline-home",
        ),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "RUN_TIMELINE_EVENTS_INVALID",
    );
  }
});

test("a run with a retired-owner takeover gap projects a timeline instead of throwing", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-timeline-gap-"));
  const options = {
    home,
    runId: "run_timeline_gap",
    initialState: 0,
    reducer: (state: number) => state,
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
  await oldStore.append("run_created", {}); // seq 1, owner A (authoritative)

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

  // Old owner's straggling post-cutoff event lands at seq 2 — non-authoritative,
  // so readAuthoritativeRunEvents drops it from the MIDDLE of the sequence.
  await appendEvent(runPaths(home, options.runId).events, {
    sequence: 2,
    timestamp: "2026-07-15T00:01:00.001Z",
    type: "notice",
    payload: {},
    runtime_owner_id: oldLease.ownerId,
  });

  const winnerStore = await RunStore.load(options);
  winnerStore.bindRuntimeOwner(winner.ownerId);
  await winnerStore.append("run_completed", {}); // seq 3, winner (authoritative)

  const events = await readAuthoritativeRunEvents(home, options.runId);
  assert.deepEqual(
    events.map((entry) => entry.sequence),
    [1, 3],
  ); // seq 2 filtered → mid-stream gap

  const timeline = buildCueLineRunTimeline(options.runId, events, home);
  assert.deepEqual(
    timeline.entries.map((entry) => entry.sequence),
    [1, 3],
  );
  assert.equal(timeline.latestSequence, 3);
  assert.equal(timeline.totalEvents, 2);

  await oldLease.release();
  await winner.release();
});
