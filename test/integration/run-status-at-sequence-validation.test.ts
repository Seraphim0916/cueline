import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadCueLineRunStatusAt, startCueLineRun } from "../../src/api.js";
import { CueLineError } from "../../src/core/errors.js";

async function environmentFor(home: string): Promise<NodeJS.ProcessEnv> {
  return {
    ...process.env,
    CUELINE_HOME: home,
    CUELINE_CONFIG: path.resolve("config/routing.default.json"),
  };
}

async function startedRun(): Promise<{ runId: string; home: string; environment: NodeJS.ProcessEnv }> {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-status-at-"));
  const environment = await environmentFor(home);
  const started = await startCueLineRun({
    request: "durable run for status-at validation",
    home,
    environment,
  });
  return { runId: started.runId, home, environment };
}

test("run status-at rejects a non-positive or non-integer sequence before reading state", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-status-at-"));
  const environment = await environmentFor(home);
  // The sequence gate runs before any run lookup, so an absent run still trips it.
  for (const sequence of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      loadCueLineRunStatusAt("run_absent", { sequence, home, environment }),
      (error: unknown) =>
        error instanceof CueLineError && error.code === "RUN_STATUS_AT_SEQUENCE_INVALID",
    );
  }
});

test("run status-at rejects a sequence ahead of the run's latest durable event", async () => {
  const { runId, home, environment } = await startedRun();
  for (const sequence of [2, 9999]) {
    await assert.rejects(
      loadCueLineRunStatusAt(runId, { sequence, home, environment }),
      (error: unknown) =>
        error instanceof CueLineError && error.code === "RUN_STATUS_AT_SEQUENCE_AHEAD",
    );
  }
});

test("run status-at reconstructs sanitized state at a valid sequence", async () => {
  const { runId, home, environment } = await startedRun();
  const at = await loadCueLineRunStatusAt(runId, { sequence: 1, home, environment });
  assert.equal(at.schema, "cueline-status-at/0.1");
  assert.equal(at.runId, runId);
  assert.equal(at.requestedSequence, 1);
  assert.equal(at.latestSequence, 1);
  assert.equal(typeof at.state.status, "string");
  assert.equal(typeof at.asOf.type, "string");
  // Sanitized projection: the reconstructed view never carries the raw request.
  assert.equal("request" in at, false);
  assert.equal("prompt" in at, false);
});
