import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { waitForCueLineRunChange } from "../../src/observation/run-watch.js";
import {
  initialRunState,
  reduceRunState,
  type CueLineRunState,
} from "../../src/core/state-machine.js";
import { RunStore } from "../../src/state/store.js";

async function fixture(
  runId: string,
): Promise<{ home: string; store: RunStore<CueLineRunState> }> {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-watch-"));
  const store = await RunStore.create({
    home,
    runId,
    initialState: initialRunState(runId, "", "caller", 12, false),
    reducer: reduceRunState,
  });
  await store.append("run_created", { request: "Watch me", executor: "caller" });
  await store.snapshot();
  return { home, store };
}

test("returns after a new durable event instead of owning the run", async () => {
  const { home, store } = await fixture("run_watch_change");
  const waiting = waitForCueLineRunChange("run_watch_change", {
    home,
    afterSequence: 1,
    timeoutMs: 500,
    pollIntervalMs: 10,
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  await store.append("run_failed", { code: "WATCH_SMOKE" });
  await store.snapshot();

  const result = await waiting;

  assert.equal(result.outcome, "changed");
  assert.equal(result.previousSequence, 1);
  assert.equal(result.currentSequence, 2);
  assert.equal(result.status.runtime.ownership, "missing");
});

test("returns a bounded timeout without writing an event", async () => {
  const { home, store } = await fixture("run_watch_timeout");

  const result = await waitForCueLineRunChange("run_watch_timeout", {
    home,
    afterSequence: 1,
    timeoutMs: 20,
    pollIntervalMs: 5,
  });

  assert.equal(result.outcome, "timed_out");
  assert.equal(result.currentSequence, 1);
  assert.equal(store.lastSequence, 1);
});

test("rejects a cursor ahead of durable state instead of waiting forever", async () => {
  const { home } = await fixture("run_watch_ahead");

  await assert.rejects(
    waitForCueLineRunChange("run_watch_ahead", {
      home,
      afterSequence: 99,
      timeoutMs: 20,
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "RUN_WATCH_CURSOR_AHEAD",
  );
});
