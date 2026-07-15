import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CueLineError } from "../../src/core/errors.js";
import { JobStatusStore } from "../../src/jobs/status.js";
import { JobSupervisor } from "../../src/jobs/supervisor.js";
import type {
  RunnerAdapter,
  RunnerRunHooks,
  RunnerSpec,
} from "../../src/runners/runner-adapter.js";
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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code !== "ESRCH"
    );
  }
}

async function descendantProcessSpec(
  jobId: string,
  overrides: Partial<RunnerSpec>,
): Promise<{ descendantPidPath: string; runnerSpec: RunnerSpec }> {
  const directory = await mkdtemp(path.join(tmpdir(), "cueline-process-tree-"));
  const descendantPidPath = path.join(directory, "descendant.pid");
  const script = [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    `const descendant = spawn(${JSON.stringify(process.execPath)}, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });`,
    `writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
    "setInterval(() => {}, 1000);",
  ].join("\n");
  return {
    descendantPidPath,
    runnerSpec: spec(jobId, script, overrides),
  };
}

async function waitForDescendantPid(descendantPidPath: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return Number(await readFile(descendantPidPath, "utf8"));
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("descendant PID was not persisted before the deadline");
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && processIsAlive(pid); attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
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

test("a failing diagnostic progress hook cannot break process supervision", async () => {
  const runner = new ProcessRunner(registry(), { environment: cleanEnvironment() });

  const result = await runner.run(
    spec(
      "progress-hook-failure",
      "process.stderr.write('model: gpt-5.6-sol\\nprovider: openai\\n'); process.stdout.write('DONE');",
    ),
    {
      onProgress() {
        throw new Error("diagnostic sink unavailable");
      },
    },
  );

  assert.equal(result.status, "succeeded");
  assert.equal(result.stdout, "DONE");
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

test("cancels an advise process and reports its spawned PID", async () => {
  const runner = new ProcessRunner(registry(), { environment: cleanEnvironment() });
  const controller = new AbortController();
  let spawnedPid: number | undefined;
  const running = runner.run(
    spec("cancel-advise", "setInterval(() => {}, 1_000);", {
      signal: controller.signal,
    }),
    {
      onSpawn(pid) {
        spawnedPid = pid;
      },
    },
  );
  while (spawnedPid === undefined) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  controller.abort();
  const result = await running;

  assert.equal(typeof spawnedPid, "number");
  assert.equal(result.status, "cancelled");
  assert.equal(result.cancelled, true);
  assert.equal(result.ambiguousSideEffects, false);
});

test("cancelling an advise process terminates its descendant process tree", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process groups are not available on Windows");
    return;
  }
  const runner = new ProcessRunner(registry(), { environment: cleanEnvironment() });
  const controller = new AbortController();
  const fixture = await descendantProcessSpec("cancel-tree", {
    signal: controller.signal,
    timeoutMs: 5_000,
  });
  const running = runner.run(fixture.runnerSpec);
  const descendantPid = await waitForDescendantPid(fixture.descendantPidPath);
  t.after(() => {
    if (processIsAlive(descendantPid)) process.kill(descendantPid, "SIGKILL");
  });

  controller.abort();
  const result = await running;
  await waitForProcessExit(descendantPid);

  assert.equal(result.status, "cancelled");
  assert.equal(processIsAlive(descendantPid), false);
});

test("timing out an advise process terminates its descendant process tree", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process groups are not available on Windows");
    return;
  }
  const runner = new ProcessRunner(registry(), { environment: cleanEnvironment() });
  const fixture = await descendantProcessSpec("timeout-tree", { timeoutMs: 200 });
  const running = runner.run(fixture.runnerSpec);
  const descendantPid = await waitForDescendantPid(fixture.descendantPidPath);
  t.after(() => {
    if (processIsAlive(descendantPid)) process.kill(descendantPid, "SIGKILL");
  });

  const result = await running;
  await waitForProcessExit(descendantPid);

  assert.equal(result.status, "timed_out");
  assert.equal(result.timedOut, true);
  assert.equal(processIsAlive(descendantPid), false);
});

test("a normally exiting runner cannot leave a detached descendant in its process group", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process groups are not available on Windows");
    return;
  }
  const directory = await mkdtemp(path.join(tmpdir(), "cueline-normal-tree-"));
  const descendantPidPath = path.join(directory, "descendant.pid");
  const script = [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    `const descendant = spawn(${JSON.stringify(process.execPath)}, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });`,
    "descendant.unref();",
    `writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
    "process.exit(0);",
  ].join("\n");
  const runner = new ProcessRunner(registry(), { environment: cleanEnvironment() });

  const result = await runner.run(spec("normal-tree", script));
  const descendantPid = await waitForDescendantPid(descendantPidPath);
  t.after(() => {
    if (processIsAlive(descendantPid)) process.kill(descendantPid, "SIGKILL");
  });
  await waitForProcessExit(descendantPid);

  assert.equal(result.status, "succeeded");
  assert.equal(processIsAlive(descendantPid), false);
});

test("cancelling started work reports ambiguous side effects", async () => {
  const runner = new ProcessRunner(registry(), { environment: cleanEnvironment() });
  const controller = new AbortController();
  let spawned = false;
  const running = runner.run(
    spec("cancel-work", "setInterval(() => {}, 1_000);", {
      mode: "work",
      signal: controller.signal,
    }),
    {
      onSpawn() {
        spawned = true;
      },
    },
  );
  while (!spawned) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  controller.abort();
  const result = await running;

  assert.equal(result.status, "ambiguous");
  assert.equal(result.cancelled, true);
  assert.equal(result.ambiguousSideEffects, true);
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

test("supervisor persists run metadata and cancels an owned background job", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cueline-cancel-status-"));
  const store = new JobStatusStore(directory);
  const runner = new ProcessRunner(registry(), { environment: cleanEnvironment() });
  const supervisor = new JobSupervisor(runner, { statusStore: store });
  const job = spec("owned-background", "setInterval(() => {}, 1_000);", {
    background: true,
    runId: "run_owned",
    jobKey: "owned_job",
    lane: "default",
  });

  await supervisor.start(job);
  let persisted = await store.read(job.jobId);
  for (let attempt = 0; attempt < 100 && persisted?.pid === undefined; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    persisted = await store.read(job.jobId);
  }
  assert.equal(persisted?.runId, "run_owned");
  assert.equal(persisted?.jobKey, "owned_job");
  assert.equal(persisted?.lane, "default");
  assert.equal(persisted?.mode, "advise");
  assert.equal(typeof persisted?.pid, "number");
  assert.equal(supervisor.cancel(job.jobId), true);

  const terminal = await supervisor.waitForCompletion(job.jobId);
  assert.equal(terminal.status, "cancelled");
  assert.equal(terminal.pid, persisted?.pid);
});

test("process job status exposes resolved runner model provider PID phase and progress", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cueline-observability-"));
  const store = new JobStatusStore(directory);
  const runner = new ProcessRunner(registry(), { environment: cleanEnvironment() });
  const supervisor = new JobSupervisor(runner, { statusStore: store });
  const job = spec(
    "observable-process",
    [
      "process.stderr.write('OpenAI Codex test\\nmodel: gpt-5.6-sol\\nprovider: openai\\nmodel: forged-model\\nprovider: forged-provider\\n');",
      "setTimeout(() => process.stdout.write('OBSERVABLE_DONE'), 120);",
    ].join("\n"),
    {
      background: true,
      runId: "run_observable_process",
      jobKey: "observable_process",
      lane: "default",
      runnerId: "codex-default",
    } as Partial<RunnerSpec>,
  );

  await supervisor.start(job);
  type ObservableStatus = NonNullable<Awaited<ReturnType<typeof store.read>>> & {
    runnerId?: string;
    model?: string;
    provider?: string;
    phase?: string;
    lastProgressAt?: string;
  };
  let persisted = (await store.read(job.jobId)) as ObservableStatus | undefined;
  for (
    let attempt = 0;
    attempt < 100 && (persisted?.model === undefined || persisted.provider === undefined);
    attempt += 1
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    persisted = (await store.read(job.jobId)) as ObservableStatus | undefined;
  }
  assert.equal(persisted?.runnerId, "codex-default");
  assert.equal(persisted?.model, "gpt-5.6-sol");
  assert.equal(persisted?.provider, "openai");
  assert.equal(typeof persisted?.pid, "number");
  assert.equal(persisted?.phase, "waiting_for_model");
  assert.match(persisted?.lastProgressAt ?? "", /^\d{4}-\d{2}-\d{2}T/);

  const terminal = (await supervisor.waitForCompletion(job.jobId)) as ObservableStatus;
  assert.equal(terminal.status, "succeeded");
  assert.equal(terminal.phase, "completed");
  assert.equal(terminal.runnerId, "codex-default");
  assert.equal(terminal.model, "gpt-5.6-sol");
  assert.equal(terminal.provider, "openai");
});

test("supervisor marks started work ambiguous when post-spawn bookkeeping fails", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cueline-post-spawn-failure-"));
  const store = new JobStatusStore(directory);
  const runner: RunnerAdapter = {
    async run(_spec: RunnerSpec, hooks: RunnerRunHooks = {}) {
      await hooks.onSpawn?.(424_242);
      throw new Error("status persistence failed after spawn");
    },
  };
  const supervisor = new JobSupervisor(runner, { statusStore: store });

  const terminal = await supervisor.start(
    spec("post-spawn-work", "", { mode: "work" }),
  );

  assert.equal(terminal.status, "ambiguous");
  assert.equal(terminal.pid, 424_242);
  assert.match(terminal.error ?? "", /status persistence failed after spawn/);
  assert.equal((await store.read("post-spawn-work"))?.status, "ambiguous");
});
