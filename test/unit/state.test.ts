import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalJson, commandHash, jobId, messageId } from "../../src/core/ids.js";
import type { RunEvent } from "../../src/state/event-log.js";
import { defaultCueLineHome, runPaths } from "../../src/state/paths.js";
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

  const eventLines = (await readFile(paths.events, "utf8")).trim().split("\n");
  assert.equal(eventLines.length, 2);
  assert.deepEqual((await readdir(paths.runDir)).sort(), ["events.jsonl", "snapshot.json"]);
  assert.ok(paths.runDir.startsWith(path.resolve(home) + path.sep));
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
