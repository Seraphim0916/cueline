import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CueLineError } from "../../src/core/errors.js";
import { JobStatusStore } from "../../src/jobs/status.js";
import { JobSupervisor } from "../../src/jobs/supervisor.js";
import type { RunnerSpec } from "../../src/runners/runner-adapter.js";
import { ProcessRunner } from "../../src/runners/process-runner.js";
import { RunnerRegistry } from "../../src/runners/registry.js";

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof CueLineError && error.code === code;
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.CUELINE_DEPTH;
  return environment;
}

function registry(): RunnerRegistry {
  return new RunnerRegistry([{ id: "node", executable: process.execPath }]);
}

function spec(jobId: string, script: string, overrides: Partial<RunnerSpec> = {}): RunnerSpec {
  return {
    jobId,
    argv: [process.execPath, "-e", script],
    mode: "advise",
    timeoutMs: 1_000,
    ...overrides,
  };
}

test("runs a registered argv without a shell and captures stdout and stderr", async () => {
  const runner = new ProcessRunner(registry(), { environment: cleanEnvironment() });

  const result = await runner.run(
    spec("capture", "process.stdout.write('OUT'); process.stderr.write('ERR');"),
  );

  assert.equal(result.status, "succeeded");
  assert.equal(result.stdout, "OUT");
  assert.equal(result.stderr, "ERR");
  assert.match(result.output, /OUT/);
  assert.match(result.output, /ERR/);
  assert.equal(result.emptyOutput, false);
  assert.equal(result.retryable, false);
});

test("injects CUELINE_DEPTH=1 into the spawned process", async () => {
  const runner = new ProcessRunner(registry(), { environment: cleanEnvironment() });

  const result = await runner.run(
    spec("depth", "process.stdout.write(process.env.CUELINE_DEPTH ?? 'missing');"),
  );

  assert.equal(result.stdout, "1");
});

test("writes an explicit task payload to stdin without invoking a shell", async () => {
  const runner = new ProcessRunner(registry(), { environment: cleanEnvironment() });

  const result = await runner.run(
    spec(
      "stdin",
      "process.stdin.setEncoding('utf8'); let data = ''; process.stdin.on('data', chunk => data += chunk); process.stdin.on('end', () => process.stdout.write(data));",
      { stdin: "TASK_FROM_STDIN" },
    ),
  );

  assert.equal(result.status, "succeeded");
  assert.equal(result.stdout, "TASK_FROM_STDIN");
});

test("rejects nested routing before it can spawn", async () => {
  const runner = new ProcessRunner(registry(), {
    environment: { ...cleanEnvironment(), CUELINE_DEPTH: "1" },
  });

  await assert.rejects(
    runner.run(spec("nested", "process.exit(0);")),
    hasCode("NESTED_ROUTING_REJECTED"),
  );
});

test("rejects argv executables that were not pre-registered", async () => {
  const runner = new ProcessRunner(new RunnerRegistry(), { environment: cleanEnvironment() });

  await assert.rejects(
    runner.run(spec("unregistered", "process.exit(0);")),
    hasCode("RUNNER_EXECUTABLE_UNREGISTERED"),
  );
});

test("reports an empty successful result", async () => {
  const runner = new ProcessRunner(registry(), { environment: cleanEnvironment() });

  const result = await runner.run(spec("empty", "process.exit(0);"));

  assert.equal(result.status, "succeeded");
  assert.equal(result.output, "");
  assert.equal(result.emptyOutput, true);
});

test("terminates a process that exceeds its timeout", async () => {
  const runner = new ProcessRunner(registry(), { environment: cleanEnvironment() });

  const result = await runner.run(
    spec("timeout", "setInterval(() => {}, 1_000);", { timeoutMs: 50 }),
  );

  assert.equal(result.status, "timed_out");
  assert.equal(result.timedOut, true);
  assert.equal(result.retryable, false);
});

test("does not retry a work job after its process exits unsuccessfully", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cueline-no-retry-"));
  const attemptsPath = path.join(directory, "attempts.txt");
  const runner = new ProcessRunner(registry(), { environment: cleanEnvironment() });
  const script = `require('node:fs').appendFileSync(${JSON.stringify(attemptsPath)}, 'x'); process.exit(7);`;

  const result = await runner.run(spec("no-retry", script, { mode: "work" }));

  assert.equal(result.status, "failed");
  assert.equal(result.ambiguousSideEffects, true);
  assert.equal(result.retryable, false);
  assert.equal(await readFile(attemptsPath, "utf8"), "x");
});

test("persists distinct foreground and background job states", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cueline-status-"));
  const store = new JobStatusStore(directory);
  const runner = new ProcessRunner(registry(), { environment: cleanEnvironment() });
  const supervisor = new JobSupervisor(runner, { statusStore: store });

  const foreground = await supervisor.start(spec("foreground", "process.stdout.write('done');"));
  assert.equal(foreground.execution, "foreground");
  assert.equal(foreground.status, "succeeded");
  assert.equal((await store.read("foreground"))?.status, "succeeded");

  const background = await supervisor.start(
    spec("background", "setTimeout(() => process.stdout.write('done'), 80);", {
      background: true,
    }),
  );
  assert.equal(background.execution, "background");
  assert.equal(background.status, "running");

  const completed = await supervisor.waitForCompletion("background");
  assert.equal(completed.execution, "background");
  assert.equal(completed.status, "succeeded");
  assert.equal((await store.read("background"))?.status, "succeeded");
  assert.equal((await supervisor.inspect("background")).status, "succeeded");
});
