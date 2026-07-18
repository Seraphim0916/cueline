import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  cancelCueLineRun,
  startCueLineRun,
  waitForCueLineRunChange,
} from "../../src/api.js";
import { CueLineError } from "../../src/core/errors.js";

async function environmentFor(home: string): Promise<NodeJS.ProcessEnv> {
  return {
    ...process.env,
    CUELINE_HOME: home,
    CUELINE_CONFIG: path.resolve("config/routing.default.json"),
  };
}

async function startedRun(): Promise<{ runId: string; home: string; environment: NodeJS.ProcessEnv }> {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-watch-"));
  const environment = await environmentFor(home);
  const started = await startCueLineRun({ request: "durable run for watch outcomes", home, environment });
  return { runId: started.runId, home, environment };
}

test("waitForCueLineRunChange rejects out-of-range watch options", async () => {
  const { runId, home, environment } = await startedRun();
  const invalid = [
    { afterSequence: -1 },
    { afterSequence: 1.5 },
    { afterSequence: 1, timeoutMs: 99_999 },
    { afterSequence: 1, timeoutMs: -1 },
    { afterSequence: 1, pollIntervalMs: 0 },
    { afterSequence: 1, pollIntervalMs: 5_000 },
  ];
  for (const options of invalid) {
    await assert.rejects(
      waitForCueLineRunChange(runId, { ...options, home, environment }),
      (error: unknown) => error instanceof CueLineError && error.code === "RUN_WATCH_OPTIONS_INVALID",
    );
  }
});

test("waitForCueLineRunChange rejects a cursor ahead of the run's latest event", async () => {
  const { runId, home, environment } = await startedRun();
  await assert.rejects(
    waitForCueLineRunChange(runId, { afterSequence: 999, home, environment }),
    (error: unknown) => error instanceof CueLineError && error.code === "RUN_WATCH_CURSOR_AHEAD",
  );
});

test("waitForCueLineRunChange times out when no new event arrives before the deadline", async () => {
  const { runId, home, environment } = await startedRun();
  const watched = await waitForCueLineRunChange(runId, {
    afterSequence: 1,
    timeoutMs: 60,
    pollIntervalMs: 10,
    home,
    environment,
  });
  assert.equal(watched.outcome, "timed_out");
  assert.equal(watched.previousSequence, 1);
});

test("waitForCueLineRunChange fails closed when its abort signal fires", async () => {
  const { runId, home, environment } = await startedRun();
  const controller = new AbortController();
  const pending = waitForCueLineRunChange(runId, {
    afterSequence: 1,
    timeoutMs: 5_000,
    pollIntervalMs: 50,
    signal: controller.signal,
    home,
    environment,
  });
  controller.abort();
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof CueLineError && error.code === "RUN_WATCH_ABORTED",
  );
});

test("waitForCueLineRunChange returns terminal for a run that has already ended", async () => {
  const { runId, home, environment } = await startedRun();
  await cancelCueLineRun(runId, { home, environment, reason: "watch outcome test" });
  const watched = await waitForCueLineRunChange(runId, {
    afterSequence: 0,
    timeoutMs: 100,
    home,
    environment,
  });
  assert.equal(watched.outcome, "terminal");
  assert.equal(watched.status.status, "cancelled");
});
