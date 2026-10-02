import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { CueLineError } from "../../src/core/errors.js";
import {
  JobStatusStore,
  parseJobStatus,
  type JobStatus,
} from "../../src/jobs/status.js";
import { JobSupervisor } from "../../src/jobs/supervisor.js";
import type {
  RunnerAdapter,
  RunnerRunHooks,
  RunnerSpec,
} from "../../src/runners/runner-adapter.js";
import { ProcessRunner } from "../../src/runners/process-runner.js";
import { RunnerRegistry } from "../../src/runners/registry.js";

// Filesystem/process readiness is real even when a runner deadline is mocked.
const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;

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

class MemoryJobStatusStore extends JobStatusStore {
  readonly writes: JobStatus[] = [];
  latest: JobStatus | undefined;

  constructor() {
    super(tmpdir());
  }

  override async write(status: JobStatus): Promise<void> {
    const snapshot = structuredClone(status);
    this.writes.push(snapshot);
    this.latest = snapshot;
  }

  override async read(jobId: string): Promise<JobStatus | undefined> {
    return this.latest?.jobId === jobId ? structuredClone(this.latest) : undefined;
  }
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

test("job status store rejects structurally invalid JSON evidence", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cueline-invalid-status-"));
  const store = new JobStatusStore(directory);
  const target = store.pathFor("malformed");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "{}\n", "utf8");

  await assert.rejects(store.read("malformed"), hasCode("JOB_STATUS_INVALID"));
});

test("job status parser rejects identity, chronology, and result contradictions", () => {
  const timestamp = "2026-07-15T00:00:00.000Z";
  const validResult = {
    status: "succeeded",
    exitCode: 0,
    stdout: "ok",
    stderr: "",
    output: "ok",
    emptyOutput: false,
    timedOut: false,
    cancelled: false,
    ambiguousSideEffects: false,
    retryable: false,
    startedAt: timestamp,
    finishedAt: timestamp,
  };
  const invalid = [
    {
      jobId: "other-job",
      execution: "foreground",
      status: "succeeded",
      startedAt: timestamp,
    },
    {
      jobId: "checked-job",
      execution: "foreground",
      status: "succeeded",
      startedAt: "2026-07-15T00:00:01.000Z",
      finishedAt: timestamp,
    },
    {
      jobId: "checked-job",
      execution: "foreground",
      status: "running",
      startedAt: timestamp,
      result: validResult,
    },
    {
      jobId: "checked-job",
      execution: "foreground",
      status: "failed",
      startedAt: timestamp,
      result: validResult,
    },
    {
      jobId: "checked-job",
      execution: "foreground",
      status: "running",
      startedAt: timestamp,
      finishedAt: timestamp,
    },
    {
      jobId: "checked-job",
      execution: "foreground",
      status: "timed_out",
      startedAt: timestamp,
      finishedAt: timestamp,
      result: { ...validResult, status: "timed_out" },
    },
  ];

  for (const value of invalid) {
    assert.throws(
      () => parseJobStatus(JSON.stringify(value), "checked-job"),
      hasCode("JOB_STATUS_INVALID"),
    );
  }
});

test("job status parser accepts cancelled ambiguous work result evidence", () => {
  const startedAt = "2026-07-15T00:00:00.000Z";
  const finishedAt = "2026-07-15T00:00:01.000Z";
  const persisted = {
    jobId: "cancelled-work-job",
    execution: "foreground",
    status: "ambiguous",
    startedAt,
    finishedAt,
    result: {
      status: "ambiguous",
      exitCode: null,
      stdout: "",
      stderr: "",
      output: "",
      emptyOutput: true,
      timedOut: false,
      cancelled: true,
      ambiguousSideEffects: true,
      retryable: false,
      startedAt,
      finishedAt,
    },
  };

  assert.deepEqual(parseJobStatus(JSON.stringify(persisted), persisted.jobId), persisted);
});

test("job status parser backfills pre-0.1.7 result evidence missing the cancelled field", () => {
  const startedAt = "2026-07-14T00:00:00.000Z";
  const finishedAt = "2026-07-14T00:03:00.000Z";
  const legacy = {
    jobId: "legacy-timed-out-job",
    execution: "foreground",
    status: "timed_out",
    startedAt,
    finishedAt,
    result: {
      status: "timed_out",
      exitCode: null,
      stdout: "partial",
      stderr: "",
      output: "partial",
      emptyOutput: false,
      timedOut: true,
      ambiguousSideEffects: false,
      retryable: false,
      startedAt,
      finishedAt,
    },
  };

  const parsed = parseJobStatus(JSON.stringify(legacy), legacy.jobId);
  assert.equal(parsed.result?.cancelled, false);
});

test("job status parser rejects contradictory cancelled result evidence", () => {
  const timestamp = "2026-07-15T00:00:00.000Z";
  const contradictions = [
    { status: "succeeded", timedOut: false, cancelled: true },
    { status: "failed", timedOut: false, cancelled: true },
    { status: "timed_out", timedOut: true, cancelled: true },
    { status: "cancelled", timedOut: false, cancelled: false },
  ];

  for (const contradiction of contradictions) {
    const persisted = {
      jobId: "contradictory-cancelled-job",
      execution: "foreground",
      status: contradiction.status,
      startedAt: timestamp,
      finishedAt: timestamp,
      result: {
        status: contradiction.status,
        exitCode: contradiction.status === "succeeded" ? 0 : null,
        stdout: "",
        stderr: "",
        output: "",
        emptyOutput: true,
        timedOut: contradiction.timedOut,
        cancelled: contradiction.cancelled,
        ambiguousSideEffects: contradiction.status !== "succeeded",
        retryable: false,
        startedAt: timestamp,
        finishedAt: timestamp,
      },
    };

    assert.throws(
      () => parseJobStatus(JSON.stringify(persisted), persisted.jobId),
      hasCode("JOB_STATUS_INVALID"),
    );
  }
});

test("job status store rejects invalid writes before creating a status file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cueline-invalid-status-write-"));
  const store = new JobStatusStore(directory);
  const invalid = {
    jobId: "invalid-write",
    execution: "foreground",
    status: "succeeded",
    startedAt: "not-a-timestamp",
  } as Parameters<typeof store.write>[0];

  await assert.rejects(store.write(invalid), hasCode("JOB_STATUS_INVALID"));
  await assert.rejects(readFile(store.pathFor("invalid-write"), "utf8"), {
    code: "ENOENT",
  });
});

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
      const contents = (await readFile(descendantPidPath, "utf8")).trim();
      const pid = Number(contents);
      // The file may be visible before its contents are written. Never let
      // Number("") become PID 0, which signals our own process group on POSIX.
      if (/^[1-9]\d*$/.test(contents) && Number.isSafeInteger(pid) && pid <= 2_147_483_647) {
        return pid;
      }
    } catch {
      // The child may not have created its readiness file yet.
    }
    await new Promise<void>((resolve) => realSetTimeout(resolve, 10));
  }
  throw new Error("descendant PID was not persisted before the deadline");
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && processIsAlive(pid); attempt += 1) {
    await new Promise<void>((resolve) => realSetTimeout(resolve, 10));
  }
}

test("descendant readiness never accepts an invalid PID file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cueline-invalid-descendant-pid-"));
  await Promise.all(["", "0", "-1", "2147483648"].map(async (contents, index) => {
    const pidPath = path.join(directory, `${index}.pid`);
    await writeFile(pidPath, contents);
    await assert.rejects(waitForDescendantPid(pidPath), /descendant PID was not persisted/);
  }));
});

test("runs a registered argv without a shell and captures stdout and stderr", async () => {
  const runner = new ProcessRunner(registry(), { environment: cleanEnvironment() });

  const result = await runner.run(
    spec("capture", "process.stdout.write('OUT'); process.stderr.write('ERR');"),
  );

  assert.equal(result.status, "succeeded");
  assert.equal(result.stdout, "OUT");
  assert.equal(result.stderr, "ERR");
  assert.equal(result.stdoutTruncatedChars, undefined);
  assert.equal(result.stderrTruncatedChars, undefined);
  assert.match(result.output, /OUT/);
  assert.match(result.output, /ERR/);
  assert.equal(result.emptyOutput, false);
  assert.equal(result.retryable, false);
});

test("bounds noisy process streams while preserving their head tail and omission count", async () => {
  const runner = new ProcessRunner(registry(), { environment: cleanEnvironment() });
  const result = await runner.run(
    spec(
      "bounded-output",
      [
        'process.stdout.write("STDOUT_HEAD\\n" + "O".repeat(700_000) + "\\nSTDOUT_TAIL");',
        'process.stderr.write("STDERR_HEAD\\n" + "E".repeat(700_000) + "\\nSTDERR_TAIL");',
      ].join("\n"),
      { timeoutMs: 5_000 },
    ),
  );

  assert.equal(result.status, "succeeded");
  assert.match(result.stdout, /^STDOUT_HEAD/);
  assert.match(result.stdout, /STDOUT_TAIL$/);
  assert.match(result.stderr, /^STDERR_HEAD/);
  assert.match(result.stderr, /STDERR_TAIL$/);
  assert.match(result.stdout, /\[truncated \d+ chars\]/);
  assert.match(result.stderr, /\[truncated \d+ chars\]/);
  assert.ok(result.stdout.length < 513_000, `stdout length was ${result.stdout.length}`);
  assert.ok(result.stderr.length < 513_000, `stderr length was ${result.stderr.length}`);
  assert.ok((result.stdoutTruncatedChars ?? 0) > 180_000);
  assert.ok((result.stderrTruncatedChars ?? 0) > 180_000);
  assert.match(result.output, /STDOUT_HEAD/);
  assert.match(result.output, /STDOUT_TAIL/);
  assert.match(result.output, /STDERR_HEAD/);
  assert.match(result.output, /STDERR_TAIL/);
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

test("rejects process timeouts that Node timers cannot represent before spawn", async () => {
  const runner = new ProcessRunner(registry(), { environment: cleanEnvironment() });

  for (const timeoutMs of [0, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    let spawned = false;
    await assert.rejects(
      runner.run(
        spec("invalid-timeout", "process.exit(0);", { timeoutMs }),
        {
          onSpawn() {
            spawned = true;
          },
        },
      ),
      hasCode("PROCESS_TIMEOUT_INVALID"),
    );
    assert.equal(spawned, false, String(timeoutMs));
  }
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

async function checkEscapedOutputPipes(
  t: TestContext,
  action: "timeout" | "cancel",
  mode: RunnerSpec["mode"] = "advise",
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "cueline-escaped-pipes-"));
  const descendantPidPath = path.join(directory, "descendant.pid");
  const descendantScript = [
    "process.on('SIGTERM', () => {});",
    "process.stdout.write('escaped stdout\\n');",
    "process.stderr.write('escaped stderr\\n');",
    `require('node:fs').writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));`,
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const script = [
    `require('node:child_process').spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(descendantScript)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });`,
    ...(mode === "work" ? ["process.on('SIGTERM', () => process.exit(7));"] : []),
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const controller = new AbortController();
  const runner = new ProcessRunner(registry(), { environment: cleanEnvironment() });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let runnerPid: number | undefined;
  let descendantPid: number | undefined;
  let settlements = 0;
  const running = runner.run(spec(`escaped-${action}-${mode}`, script, {
    timeoutMs: action === "timeout" ? 200 : 10_000,
    signal: controller.signal,
    mode,
  }), { onSpawn(pid) { runnerPid = pid; } }).then((result) => {
    settlements += 1;
    return result;
  });
  t.after(async () => {
    controller.abort();
    t.mock.timers.tick(250);
    // Read the PID again even if readiness/assertions failed earlier.
    if (descendantPid === undefined) {
      try { descendantPid = await waitForDescendantPid(descendantPidPath); } catch {}
    }
    for (const pid of [runnerPid === undefined ? undefined : -runnerPid, descendantPid]) {
      if (pid === undefined) continue;
      try { process.kill(pid, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    for (const pid of [runnerPid, descendantPid]) {
      if (pid === undefined) continue;
      await waitForProcessExit(pid);
      assert.equal(processIsAlive(pid), false, `fixture PID ${pid} must be dead`);
    }
    // Closing the held pipes also lets the unfixed runner finish during cleanup.
    await boundedCompletion();
    t.mock.timers.tick(2_000);
    assert.equal(settlements, 1, "late close must not settle twice");
  });
  async function boundedCompletion() {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        running,
        new Promise<never>((_, reject) => {
          deadline = realSetTimeout(() => reject(new Error("job still waiting for escaped output pipes")), 500);
        }),
      ]);
    } finally {
      if (deadline !== undefined) realClearTimeout(deadline);
    }
  }
  descendantPid = await waitForDescendantPid(descendantPidPath);
  assert.equal(processIsAlive(descendantPid), true);
  if (action === "timeout") t.mock.timers.tick(200);
  else controller.abort();
  // Let the real SIGTERM handler exit before advancing the mocked SIGKILL.
  if (mode === "work") await waitForProcessExit(runnerPid!);
  t.mock.timers.tick(250);
  await waitForProcessExit(runnerPid!);
  assert.equal(processIsAlive(runnerPid!), false);
  assert.equal(processIsAlive(descendantPid), true, "escaped descendant must survive group kill");
  assert.equal(settlements, 0, "open pipes must still be pending before the second deadline");
  t.mock.timers.tick(999);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settlements, 0);
  t.mock.timers.tick(1);
  const result = await boundedCompletion();
  assert.equal(result.status, action === "timeout" ? "timed_out" : mode === "work" ? "ambiguous" : "cancelled");
  assert.equal(result.exitCode, mode === "work" ? 7 : null);
  assert.equal(result.timedOut, action === "timeout");
  assert.equal(result.cancelled, action === "cancel");
  assert.equal(result.ambiguousSideEffects, mode === "work");
  assert.equal(result.stdout, "escaped stdout\n");
  assert.match(result.stderr, /^escaped stderr\n/);
  assert.equal(result.stderr.match(/descendant outside the process group/g)?.length, 1);
  assert.equal(result.output, result.stdout + result.stderr);
  assert.equal(processIsAlive(descendantPid), true, "settlement must not rely on killing the escaped descendant");
}

test("timing out settles despite escaped descendants holding output pipes", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX process groups are not available on Windows");
  await checkEscapedOutputPipes(t, "timeout");
});

test("cancelling settles despite escaped descendants holding output pipes", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX process groups are not available on Windows");
  for (const mode of ["advise", "work"] as const) {
    await t.test(mode, async (subtest) => checkEscapedOutputPipes(subtest, "cancel", mode));
  }
});

test("normal close does not wait for the forced output pipe deadline", { timeout: 5_000 }, async (t) => {
  if (process.platform === "win32") return t.skip("POSIX process groups are not available on Windows");
  for (const resistTerm of [false, true]) {
    await t.test(resistTerm ? "close after forced kill clears the deadline" : "close before forced kill never arms the deadline", async (subtest) => {
      const directory = await mkdtemp(path.join(tmpdir(), "cueline-normal-pipes-"));
      const pidPath = path.join(directory, "child.pid");
      const script = [
        ...(resistTerm ? ["process.on('SIGTERM', () => {});"] : []),
        `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
        "setInterval(() => {}, 1000);",
      ].join("\n");
      subtest.mock.timers.enable({ apis: ["setTimeout"] });
      const scheduled = subtest.mock.method(globalThis, "setTimeout");
      const cleared = subtest.mock.method(globalThis, "clearTimeout");
      const controller = new AbortController();
      let runnerPid: number | undefined;
      const runner = new ProcessRunner(registry(), { environment: cleanEnvironment() });
      const running = runner.run(spec("normal-pipes", script, { timeoutMs: 200, signal: controller.signal }), {
        onSpawn(pid) { runnerPid = pid; },
      });
      subtest.after(async () => {
        controller.abort();
        subtest.mock.timers.tick(250);
        if (runnerPid !== undefined) {
          try { process.kill(-runnerPid, "SIGKILL"); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
          await waitForProcessExit(runnerPid);
          assert.equal(processIsAlive(runnerPid), false);
        }
      });
      await waitForDescendantPid(pidPath);
      subtest.mock.timers.tick(200);
      if (resistTerm) subtest.mock.timers.tick(250);
      const result = await running;
      const deadlines = scheduled.mock.calls.filter((call) => call.arguments[1] === 1_000);
      assert.equal(deadlines.length, resistTerm ? 1 : 0);
      if (resistTerm) {
        assert.ok(cleared.mock.calls.some((call) => call.arguments[0] === deadlines[0]!.result));
      }
      subtest.mock.timers.tick(2_000);
      assert.equal(result.status, "timed_out");
      assert.equal(result.stderr, "");
    });
  }
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

for (const startupDelayMs of [0, 300]) {
  test(`timing out an advise process terminates its descendant process tree${startupDelayMs > 0 ? " after delayed startup" : ""}`, { timeout: 10_000 }, async (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX process groups are not available on Windows");
      return;
    }
    const runner = new ProcessRunner(registry(), { environment: cleanEnvironment() });
    const controller = new AbortController();
    const fixture = await descendantProcessSpec("timeout-tree", {
      timeoutMs: 200,
      signal: controller.signal,
    });
    if (startupDelayMs > 0) {
      // Deliberately take longer than the runner deadline to build the real
      // process tree. Readiness must not race that independently tested clock.
      fixture.runnerSpec.argv = [process.execPath, "-e",
        `setTimeout(() => {\n${fixture.runnerSpec.argv[2]}\n}, ${startupDelayMs});`];
    }
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let runnerPid: number | undefined;
    let descendantPid: number | undefined;
    let settled = false;
    const running = runner.run(fixture.runnerSpec, {
      onSpawn(pid) { runnerPid = pid; },
    }).then((result) => {
      settled = true;
      return result;
    });
    // Register before readiness: a broken fixture must not leak the real
    // process group while its deadline is paused on the controlled clock.
    t.after(async () => {
      controller.abort();
      t.mock.timers.tick(250);
      if (runnerPid !== undefined) {
        try {
          process.kill(-runnerPid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      if (descendantPid !== undefined && processIsAlive(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
      await running;
    });
    descendantPid = await waitForDescendantPid(fixture.descendantPidPath);
    assert.ok(runnerPid);
    assert.equal(processIsAlive(runnerPid), true);
    assert.equal(processIsAlive(descendantPid), true);

    t.mock.timers.tick(199);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "runner must not finish before its deadline");
    assert.equal(processIsAlive(runnerPid), true);
    assert.equal(processIsAlive(descendantPid), true);
    t.mock.timers.tick(1);
    // Drive the real runner's force-kill grace too, so TERM-resistant children
    // cannot leave the test waiting on another paused timer.
    t.mock.timers.tick(250);
    const result = await running;
    await waitForProcessExit(descendantPid);

    assert.equal(result.status, "timed_out");
    assert.equal(result.timedOut, true);
    assert.equal(result.cancelled, false);
    assert.equal(processIsAlive(runnerPid), false);
    assert.equal(processIsAlive(descendantPid), false);
  });
}

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

test("same-millisecond concurrent job status writes use distinct atomic temporaries", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cueline-status-concurrent-"));
  const store = new JobStatusStore(directory);
  const originalNow = Date.now;
  Date.now = () => 1_784_150_400_000;
  try {
    await Promise.all(
      Array.from({ length: 64 }, (_, index) =>
        store.write({
          jobId: "same-millisecond",
          execution: "foreground",
          status: "running",
          phase: `write_${index}`,
          startedAt: "2026-07-15T00:00:00.000Z",
        }),
      ),
    );
  } finally {
    Date.now = originalNow;
  }

  const persisted = await store.read("same-millisecond");
  assert.equal(persisted?.status, "running");
  assert.match(persisted?.phase ?? "", /^write_\d+$/);
  assert.deepEqual(await readdir(path.dirname(store.pathFor("same-millisecond"))), [
    "same-millisecond.json",
  ]);
});

test("durable job status writes preserve JSON omission of optional undefined fields", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cueline-status-undefined-"));
  const store = new JobStatusStore(directory);

  await store.write(
    {
      jobId: "optional-undefined",
      execution: "foreground",
      status: "running",
      phase: undefined,
      startedAt: "2026-07-15T00:00:00.000Z",
    } as unknown as JobStatus,
  );

  const persisted = await store.read("optional-undefined");
  assert.equal(persisted?.status, "running");
  assert.equal(Object.hasOwn(persisted ?? {}, "phase"), false);
});

test("a terminal job status cannot regress to a late running update", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cueline-status-terminal-fence-"));
  const store = new JobStatusStore(directory);
  const terminal: JobStatus = {
    jobId: "terminal-fence",
    runId: "run_terminal_fence",
    jobKey: "terminal_fence",
    execution: "foreground",
    status: "succeeded",
    startedAt: "2026-07-15T00:00:00.000Z",
    finishedAt: "2026-07-15T00:01:00.000Z",
    result: {
      status: "succeeded",
      stdout: "TERMINAL_PROOF",
      stderr: "",
      output: "TERMINAL_PROOF",
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      ambiguousSideEffects: false,
      emptyOutput: false,
      retryable: false,
      startedAt: "2026-07-15T00:00:00.000Z",
      finishedAt: "2026-07-15T00:01:00.000Z",
    },
  };

  await store.write(terminal);
  await assert.rejects(
    store.write({
      jobId: terminal.jobId,
      runId: "run_terminal_fence",
      jobKey: "terminal_fence",
      execution: "foreground",
      status: "running",
      phase: "late_progress",
      startedAt: terminal.startedAt,
    }),
    hasCode("JOB_STATUS_ALREADY_TERMINAL"),
  );

  assert.deepEqual(await store.read(terminal.jobId), terminal);
  assert.deepEqual(
    JSON.parse(await readFile(store.pathFor(terminal.jobId), "utf8")),
    terminal,
  );
});

test("concurrent running updates cannot outlive the first durable terminal status", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cueline-status-terminal-race-"));
  const store = new JobStatusStore(directory);
  const terminal: JobStatus = {
    jobId: "terminal-race",
    execution: "foreground",
    status: "failed",
    startedAt: "2026-07-15T00:00:00.000Z",
    finishedAt: "2026-07-15T00:01:00.000Z",
    error: "FIRST_TERMINAL_WINS",
  };

  const writes = await Promise.allSettled([
    ...Array.from({ length: 64 }, (_, index) =>
      store.write({
        jobId: terminal.jobId,
        execution: "foreground",
        status: "running",
        phase: `late_${index}`,
        startedAt: terminal.startedAt,
      }),
    ),
    store.write(terminal),
  ]);

  for (const write of writes) {
    if (write.status === "rejected") {
      assert.equal(hasCode("JOB_STATUS_ALREADY_TERMINAL")(write.reason), true);
    }
  }
  assert.deepEqual(await store.read(terminal.jobId), terminal);
  assert.deepEqual(
    (await readdir(path.dirname(store.pathFor(terminal.jobId)))).sort(),
    ["terminal-race.json", "terminal-race.terminal"],
  );
});

test("terminal retries are idempotent but conflicting terminal evidence is rejected", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cueline-status-terminal-conflict-"));
  const store = new JobStatusStore(directory);
  const terminal: JobStatus = {
    jobId: "terminal-conflict",
    execution: "foreground",
    status: "failed",
    startedAt: "2026-07-15T00:00:00.000Z",
    finishedAt: "2026-07-15T00:01:00.000Z",
    error: "ORIGINAL_FAILURE",
  };

  await store.write(terminal);
  await store.write({ ...terminal });
  await assert.rejects(
    store.write({
      jobId: terminal.jobId,
      execution: terminal.execution,
      status: "succeeded",
      startedAt: terminal.startedAt,
      finishedAt: "2026-07-15T00:01:00.000Z",
    }),
    hasCode("JOB_STATUS_TERMINAL_CONFLICT"),
  );

  assert.deepEqual(await store.read(terminal.jobId), terminal);
});

test("concurrent conflicting terminal writers commit exactly one immutable winner", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cueline-status-terminal-winner-"));
  const store = new JobStatusStore(directory);
  const failed: JobStatus = {
    jobId: "terminal-winner",
    execution: "foreground",
    status: "failed",
    startedAt: "2026-07-15T00:00:00.000Z",
    finishedAt: "2026-07-15T00:01:00.000Z",
    error: "FAILED_WINNER",
  };
  const succeeded: JobStatus = {
    jobId: "terminal-winner",
    execution: "foreground",
    status: "succeeded",
    startedAt: "2026-07-15T00:00:00.000Z",
    finishedAt: "2026-07-15T00:01:00.000Z",
  };

  const attempts = await Promise.allSettled([
    store.write(failed),
    store.write(succeeded),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  const rejected = attempts.find((attempt) => attempt.status === "rejected");
  assert.equal(
    rejected?.status === "rejected" &&
      hasCode("JOB_STATUS_TERMINAL_CONFLICT")(rejected.reason),
    true,
  );
  const committed = await store.read("terminal-winner");
  assert.deepEqual(committed, committed?.status === "failed" ? failed : succeeded);
});

test("legacy terminal files are fenced before a newer writer can regress them", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cueline-status-terminal-legacy-"));
  const store = new JobStatusStore(directory);
  const terminal: JobStatus = {
    jobId: "legacy-terminal",
    execution: "foreground",
    status: "ambiguous",
    startedAt: "2026-07-15T00:00:00.000Z",
    finishedAt: "2026-07-15T00:01:00.000Z",
    error: "LEGACY_TERMINAL_PROOF",
  };
  await mkdir(path.dirname(store.pathFor(terminal.jobId)), { recursive: true });
  await writeFile(store.pathFor(terminal.jobId), `${JSON.stringify(terminal)}\n`, "utf8");

  await assert.rejects(
    store.write({
      jobId: terminal.jobId,
      execution: "foreground",
      status: "running",
      startedAt: terminal.startedAt,
    }),
    hasCode("JOB_STATUS_ALREADY_TERMINAL"),
  );
  await unlink(store.pathFor(terminal.jobId));

  assert.deepEqual(await store.read(terminal.jobId), terminal);
});

test("a supervisor cannot spawn a job whose durable status is already terminal", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cueline-status-terminal-respawn-"));
  const store = new JobStatusStore(directory);
  let runnerCalls = 0;
  const runner: RunnerAdapter = {
    async run() {
      runnerCalls += 1;
      throw new Error("runner must not be reached");
    },
  };
  const supervisor = new JobSupervisor(runner, { statusStore: store });
  await store.write({
    jobId: "terminal-respawn",
    execution: "foreground",
    status: "failed",
    startedAt: "2026-07-15T00:00:00.000Z",
    finishedAt: "2026-07-15T00:01:00.000Z",
    error: "ALREADY_FINISHED",
  });

  await assert.rejects(
    supervisor.start(spec("terminal-respawn", "process.exit(0);")),
    hasCode("JOB_STATUS_ALREADY_TERMINAL"),
  );
  assert.equal(runnerCalls, 0);
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

test("supervisor coalesces burst progress before persisting the terminal result", async () => {
  const store = new MemoryJobStatusStore();
  const progressCount = 2_000;
  const startedAt = new Date("2026-07-15T00:00:00.000Z");
  const runner: RunnerAdapter = {
    async run(_spec: RunnerSpec, hooks: RunnerRunHooks = {}) {
      await hooks.onSpawn?.(432_100);
      for (let index = 0; index < progressCount; index += 1) {
        void hooks.onProgress?.({
          phase: `output_${index}`,
          at: new Date(startedAt.getTime() + index).toISOString(),
          ...(index === 0 ? { provider: "openai" } : {}),
          ...(index === progressCount - 1 ? { model: "gpt-5.6-sol" } : {}),
        });
      }
      const finishedAt = new Date(startedAt.getTime() + progressCount).toISOString();
      return {
        status: "succeeded",
        exitCode: 0,
        stdout: "DONE",
        stderr: "",
        output: "DONE",
        emptyOutput: false,
        timedOut: false,
        cancelled: false,
        ambiguousSideEffects: false,
        retryable: false,
        startedAt: startedAt.toISOString(),
        finishedAt,
      };
    },
  };
  const supervisor = new JobSupervisor(runner, { statusStore: store });

  const terminal = await supervisor.start(spec("progress-burst", ""));

  assert.equal(terminal.status, "succeeded");
  assert.equal(terminal.phase, "completed");
  assert.equal(terminal.pid, 432_100);
  assert.equal(terminal.provider, "openai");
  assert.equal(terminal.model, "gpt-5.6-sol");
  assert.equal(
    terminal.lastProgressAt,
    new Date(startedAt.getTime() + progressCount).toISOString(),
  );
  assert.equal(store.writes.at(0)?.status, "running");
  assert.equal(store.writes.at(-1)?.status, "succeeded");
  assert.ok(
    store.writes.length <= 5,
    `expected burst progress to be coalesced, received ${store.writes.length} writes`,
  );
});

test("supervisor ignores diagnostic progress emitted after a runner returns", async () => {
  const store = new MemoryJobStatusStore();
  let finishLateProgress: (() => void) | undefined;
  const lateProgressFinished = new Promise<void>((resolve) => {
    finishLateProgress = resolve;
  });
  const startedAt = "2026-07-15T00:00:00.000Z";
  const finishedAt = "2026-07-15T00:00:01.000Z";
  const runner: RunnerAdapter = {
    async run(_spec: RunnerSpec, hooks: RunnerRunHooks = {}) {
      await hooks.onSpawn?.(432_101);
      setImmediate(() => {
        void Promise.resolve(
          hooks.onProgress?.({
            phase: "late_output",
            at: "2026-07-15T00:00:02.000Z",
          }),
        ).finally(() => finishLateProgress?.());
      });
      return {
        status: "succeeded",
        exitCode: 0,
        stdout: "DONE",
        stderr: "",
        output: "DONE",
        emptyOutput: false,
        timedOut: false,
        cancelled: false,
        ambiguousSideEffects: false,
        retryable: false,
        startedAt,
        finishedAt,
      };
    },
  };
  const supervisor = new JobSupervisor(runner, { statusStore: store });

  const terminal = await supervisor.start(spec("late-progress", ""));
  await lateProgressFinished;

  assert.equal(terminal.status, "succeeded");
  assert.equal((await store.read("late-progress"))?.status, "succeeded");
  assert.equal(store.writes.at(-1)?.status, "succeeded");
  assert.equal(store.writes.some((status) => status.phase === "late_output"), false);
});

test("supervisor reports a progress persistence failure instead of false success", async () => {
  class FailingProgressStore extends MemoryJobStatusStore {
    attempts = 0;

    override async write(status: JobStatus): Promise<void> {
      this.attempts += 1;
      if (this.attempts === 3) {
        throw new Error("progress persistence unavailable");
      }
      await super.write(status);
    }
  }

  const store = new FailingProgressStore();
  const runner: RunnerAdapter = {
    async run(_spec: RunnerSpec, hooks: RunnerRunHooks = {}) {
      await hooks.onSpawn?.(432_102);
      void Promise.resolve(
        hooks.onProgress?.({
          phase: "producing_output",
          at: "2026-07-15T00:00:00.500Z",
        }),
      ).catch(() => undefined);
      return {
        status: "succeeded",
        exitCode: 0,
        stdout: "DONE",
        stderr: "",
        output: "DONE",
        emptyOutput: false,
        timedOut: false,
        cancelled: false,
        ambiguousSideEffects: false,
        retryable: false,
        startedAt: "2026-07-15T00:00:00.000Z",
        finishedAt: "2026-07-15T00:00:01.000Z",
      };
    },
  };
  const supervisor = new JobSupervisor(runner, { statusStore: store });

  const terminal = await supervisor.start(spec("progress-write-failure", ""));

  assert.equal(terminal.status, "failed");
  assert.match(terminal.error ?? "", /progress persistence unavailable/);
  assert.equal((await store.read("progress-write-failure"))?.status, "failed");
});
