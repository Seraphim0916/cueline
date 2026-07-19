import assert from "node:assert/strict";
import test from "node:test";

import { ProcessRunner } from "../../src/runners/process-runner.js";
import { RunnerRegistry } from "../../src/runners/registry.js";
import type { RunnerSpec } from "../../src/runners/runner-adapter.js";

function cleanEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.CUELINE_DEPTH;
  return environment;
}

test("a stdin job whose child exits before draining the pipe completes instead of crashing the process", async () => {
  // Regression: without an "error" listener on child.stdin, a large stdin write
  // to a child that has already exited emits EPIPE, which Node rethrows as an
  // uncaught exception that takes the whole process down (the controller loop and
  // every concurrent job), not just this one job. A payload well past the OS pipe
  // buffer (~64KB) against an immediately-exiting child reliably triggers the
  // write error; the runner must swallow it and still report the child's real
  // exit result. On the pre-fix code this scenario crashed the test process
  // outright, so simply completing with a status is the regression guard.
  const runner = new ProcessRunner(
    new RunnerRegistry([{ id: "node", executable: process.execPath }]),
    { environment: cleanEnvironment() },
  );

  const spec: RunnerSpec = {
    jobId: "stdin_epipe",
    argv: [process.execPath, "-e", "process.exit(0)"],
    mode: "advise",
    timeoutMs: 5_000,
    stdin: "x".repeat(5 * 1024 * 1024),
  };

  const result = await runner.run(spec);
  assert.equal(result.status, "succeeded");
});
