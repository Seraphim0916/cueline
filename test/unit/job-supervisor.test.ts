import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";

import { CueLineError } from "../../src/core/errors.js";
import { JobStatusStore, type JobStatus } from "../../src/jobs/status.js";
import { JobSupervisor } from "../../src/jobs/supervisor.js";
import type {
  JobResult,
  JobResultStatus,
  RunnerAdapter,
  RunnerRunHooks,
  RunnerSpec,
} from "../../src/runners/runner-adapter.js";

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof CueLineError && error.code === code;
}

class MemoryJobStatusStore extends JobStatusStore {
  readonly writes: JobStatus[] = [];
  readonly statuses = new Map<string, JobStatus>();
  failWrite: ((status: JobStatus) => unknown) | undefined;
  writeGate: Promise<void> | undefined;

  constructor() {
    super(tmpdir());
  }

  override async write(status: JobStatus): Promise<void> {
    if (this.writeGate !== undefined) await this.writeGate;
    const failure = this.failWrite?.(status);
    if (failure !== undefined) throw failure;
    const snapshot = structuredClone(status);
    this.writes.push(snapshot);
    this.statuses.set(status.jobId, snapshot);
  }

  override async read(jobId: string): Promise<JobStatus | undefined> {
    const status = this.statuses.get(jobId);
    return status === undefined ? undefined : structuredClone(status);
  }
}

function result(status: JobResultStatus = "succeeded"): JobResult {
  return {
    status,
    exitCode: status === "succeeded" ? 0 : 1,
    stdout: "out",
    stderr: "",
    output: "out",
    emptyOutput: false,
    timedOut: status === "timed_out",
    cancelled: status === "cancelled",
    ambiguousSideEffects: false,
    retryable: false,
    startedAt: "2026-10-26T00:00:00.000Z",
    finishedAt: "2026-10-26T00:00:01.000Z",
  };
}

type RunBody = (spec: RunnerSpec, hooks: RunnerRunHooks) => Promise<JobResult>;

class ScriptedRunner implements RunnerAdapter {
  readonly specs: RunnerSpec[] = [];
  readonly hooks: RunnerRunHooks[] = [];

  constructor(private readonly body: RunBody = async () => result()) {}

  run(spec: RunnerSpec, hooks: RunnerRunHooks = {}): Promise<JobResult> {
    this.specs.push(spec);
    this.hooks.push(hooks);
    return this.body(spec, hooks);
  }
}

function spec(jobId: string, overrides: Partial<RunnerSpec> = {}): RunnerSpec {
  return { jobId, argv: ["worker"], mode: "advise", timeoutMs: 1_000, ...overrides };
}

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test("foreground start persists running then terminal status with run identity", async () => {
  const store = new MemoryJobStatusStore();
  const supervisor = new JobSupervisor(new ScriptedRunner(), { statusStore: store });

  const terminal = await supervisor.start(
    spec("job_fg", { runId: "run_a", jobKey: "audit", lane: "default", runnerId: "worker" }),
  );

  assert.equal(terminal.status, "succeeded");
  assert.equal(terminal.phase, "completed");
  assert.equal(terminal.finishedAt, "2026-10-26T00:00:01.000Z");
  assert.equal(terminal.lastProgressAt, terminal.finishedAt);
  assert.equal(terminal.result?.output, "out");
  assert.deepEqual(store.writes.map((write) => write.status), ["running", "succeeded"]);
  const running = store.writes[0];
  assert.equal(running?.phase, "starting");
  assert.equal(running?.execution, "foreground");
  assert.equal(running?.runId, "run_a");
  assert.equal(running?.jobKey, "audit");
  assert.equal(running?.lane, "default");
  assert.equal(running?.runnerId, "worker");
  assert.equal(running?.mode, "advise");
});

test("running status omits identity fields the spec does not carry", async () => {
  const store = new MemoryJobStatusStore();
  const supervisor = new JobSupervisor(new ScriptedRunner(), { statusStore: store });
  await supervisor.start(spec("job_bare"));
  const running = store.writes[0];
  for (const key of ["runId", "jobKey", "lane", "runnerId"]) {
    assert.equal(Object.hasOwn(running ?? {}, key), false, key);
  }
});

test("non-success results map their status to the terminal phase", async () => {
  for (const status of ["failed", "timed_out", "cancelled"] as const) {
    const store = new MemoryJobStatusStore();
    const supervisor = new JobSupervisor(new ScriptedRunner(async () => result(status)), {
      statusStore: store,
    });
    const terminal = await supervisor.start(spec(`job_${status}`));
    assert.equal(terminal.status, status);
    assert.equal(terminal.phase, status);
  }
});

test("background start returns the persisted running status and completes the same execution", async () => {
  const store = new MemoryJobStatusStore();
  const gate = deferred();
  const runner = new ScriptedRunner(async () => {
    await gate.promise;
    return result();
  });
  const supervisor = new JobSupervisor(runner, { statusStore: store });

  const running = await supervisor.start(spec("job_bg", { background: true }));
  assert.equal(running.status, "running");
  assert.equal(running.execution, "background");
  const waiting = supervisor.waitForCompletion("job_bg");
  await assert.rejects(supervisor.start(spec("job_bg")), hasCode("JOB_ALREADY_RUNNING"));

  gate.resolve();
  const terminal = await waiting;
  assert.equal(terminal.status, "succeeded");
  assert.equal(runner.specs.length, 1);
  // After completion the persisted status answers and the lock is free again.
  assert.deepEqual(await supervisor.waitForCompletion("job_bg"), terminal);
  assert.deepEqual(await supervisor.inspect("job_bg"), terminal);
});

test("lookups for an unknown job reject with JOB_NOT_FOUND", async () => {
  const supervisor = new JobSupervisor(new ScriptedRunner(), {
    statusStore: new MemoryJobStatusStore(),
  });
  await assert.rejects(supervisor.waitForCompletion("missing"), hasCode("JOB_NOT_FOUND"));
  await assert.rejects(supervisor.inspect("missing"), hasCode("JOB_NOT_FOUND"));
});

test("a failed initial status write releases the lock and never runs the job", async () => {
  const store = new MemoryJobStatusStore();
  const writeError = new Error("disk full");
  store.failWrite = () => writeError;
  const runner = new ScriptedRunner();
  const supervisor = new JobSupervisor(runner, { statusStore: store });

  await assert.rejects(supervisor.start(spec("job_write")), (error) => error === writeError);
  assert.equal(runner.specs.length, 0);
  assert.equal(supervisor.cancel("job_write"), false);

  store.failWrite = undefined;
  assert.equal((await supervisor.start(spec("job_write"))).status, "succeeded");
});

test("a failed terminal write rejects but still releases the job", async () => {
  const store = new MemoryJobStatusStore();
  const terminalError = new Error("terminal write failed");
  store.failWrite = (status) => (status.status === "running" ? undefined : terminalError);
  const supervisor = new JobSupervisor(new ScriptedRunner(), { statusStore: store });

  await assert.rejects(supervisor.start(spec("job_terminal")), (error) => error === terminalError);
  store.failWrite = undefined;
  // No in-flight completion is left behind: the persisted running record answers.
  assert.equal((await supervisor.waitForCompletion("job_terminal")).status, "running");
  assert.equal((await supervisor.start(spec("job_terminal"))).status, "succeeded");
});

test("a thrown runner error after spawn makes work ambiguous but advice failed", async () => {
  for (const [mode, expected] of [["work", "ambiguous"], ["advise", "failed"]] as const) {
    const store = new MemoryJobStatusStore();
    const runner = new ScriptedRunner(async (_spec, hooks) => {
      await hooks.onSpawn?.(4242);
      throw new Error(`${mode} crashed`);
    });
    const supervisor = new JobSupervisor(runner, { statusStore: store });

    const terminal = await supervisor.start(spec(`job_${mode}`, { mode }));
    assert.equal(terminal.status, expected);
    assert.equal(terminal.phase, "failed");
    assert.equal(terminal.pid, 4242);
    assert.equal(terminal.error, `${mode} crashed`);
    assert.equal(terminal.finishedAt, terminal.lastProgressAt);
    assert.equal(terminal.result, undefined);
  }
});

test("a work runner that throws before spawning is failed, and non-Error throws are stringified", async () => {
  const supervisor = new JobSupervisor(
    new ScriptedRunner(async () => {
      throw "plain rejection";
    }),
    { statusStore: new MemoryJobStatusStore() },
  );
  const terminal = await supervisor.start(spec("job_nospawn", { mode: "work" }));
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.pid, undefined);
  assert.equal(terminal.error, "plain rejection");
});

test("cancel aborts the runner signal once and reports unknown or finished jobs as false", async () => {
  const store = new MemoryJobStatusStore();
  const runner = new ScriptedRunner(
    (runSpec) =>
      new Promise((resolve) => {
        runSpec.signal?.addEventListener("abort", () => resolve(result("cancelled")), { once: true });
      }),
  );
  const supervisor = new JobSupervisor(runner, { statusStore: store });

  await supervisor.start(spec("job_cancel", { background: true }));
  assert.equal(supervisor.cancel("unknown"), false);
  assert.equal(supervisor.cancel("job_cancel"), true);
  assert.equal(supervisor.cancel("job_cancel"), false);
  assert.equal((await supervisor.waitForCompletion("job_cancel")).status, "cancelled");
  assert.equal(supervisor.cancel("job_cancel"), false);
});

test("cancelAll counts only jobs it actually aborted", async () => {
  const runner = new ScriptedRunner(
    (runSpec) =>
      new Promise((resolve) => {
        runSpec.signal?.addEventListener("abort", () => resolve(result("cancelled")), { once: true });
      }),
  );
  const supervisor = new JobSupervisor(runner, { statusStore: new MemoryJobStatusStore() });
  await supervisor.start(spec("job_1", { background: true }));
  await supervisor.start(spec("job_2", { background: true }));
  assert.equal(supervisor.cancel("job_1"), true);

  assert.equal(supervisor.cancelAll(), 1);
  assert.equal(supervisor.cancelAll(), 0);
  await supervisor.waitForCompletion("job_1");
  await supervisor.waitForCompletion("job_2");
  assert.equal(supervisor.cancelAll(), 0);
});

test("an external caller signal is combined with supervisor cancellation", async () => {
  const external = new AbortController();
  const runner = new ScriptedRunner(
    (runSpec) =>
      new Promise((resolve) => {
        runSpec.signal?.addEventListener("abort", () => resolve(result("cancelled")), { once: true });
      }),
  );
  const supervisor = new JobSupervisor(runner, { statusStore: new MemoryJobStatusStore() });
  await supervisor.start(spec("job_external", { background: true, signal: external.signal }));
  assert.notEqual(runner.specs[0]?.signal, external.signal);

  external.abort();
  assert.equal((await supervisor.waitForCompletion("job_external")).status, "cancelled");
});

test("progress updates merge into the running status and coalesce while a write is in flight", async () => {
  const store = new MemoryJobStatusStore();
  const progressDone: Promise<void>[] = [];
  const runner = new ScriptedRunner(async (_spec, hooks) => {
    await hooks.onSpawn?.(77);
    const gate = deferred();
    store.writeGate = gate.promise;
    for (const phase of ["thinking", "editing", "testing"]) {
      progressDone.push(
        Promise.resolve(
          hooks.onProgress?.({
            phase,
            at: "2026-10-26T00:00:00.500Z",
            ...(phase === "testing" ? { model: "m1", provider: "p1" } : {}),
          }),
        ),
      );
    }
    store.writeGate = undefined;
    gate.resolve();
    await Promise.all(progressDone);
    return result();
  });
  const supervisor = new JobSupervisor(runner, { statusStore: store });

  const terminal = await supervisor.start(spec("job_progress"));
  const runningWrites = store.writes.filter((write) => write.status === "running");
  // starting + spawn + at most two writes for three progress updates.
  assert.ok(runningWrites.length <= 4, `writes: ${runningWrites.length}`);
  const latest = runningWrites.at(-1);
  assert.equal(latest?.phase, "testing");
  assert.equal(latest?.pid, 77);
  assert.equal(latest?.model, "m1");
  assert.equal(latest?.provider, "p1");
  assert.equal(terminal.pid, 77);
  assert.equal(terminal.model, "m1");
  assert.equal(terminal.status, "succeeded");
});

test("progress reported after the runner returns is ignored", async () => {
  const store = new MemoryJobStatusStore();
  const runner = new ScriptedRunner();
  const supervisor = new JobSupervisor(runner, { statusStore: store });
  await supervisor.start(spec("job_late"));
  const writes = store.writes.length;

  await runner.hooks[0]?.onProgress?.({ phase: "late", at: "2026-10-26T00:00:02.000Z" });
  await runner.hooks[0]?.onSpawn?.(1);
  assert.equal(store.writes.length, writes);
});

test("a failed progress write fails later progress and turns a spawned work success into ambiguous", async () => {
  const store = new MemoryJobStatusStore();
  const progressError = new Error("progress write failed");
  store.failWrite = (status) =>
    status.status === "running" && status.phase !== "starting" ? progressError : undefined;
  const hookErrors: unknown[] = [];
  const runner = new ScriptedRunner(async (_spec, hooks) => {
    await Promise.resolve(hooks.onSpawn?.(9)).catch((error: unknown) => hookErrors.push(error));
    await Promise.resolve(hooks.onProgress?.({ phase: "after", at: "2026-10-26T00:00:00.100Z" }))
      .catch((error: unknown) => hookErrors.push(error));
    return result();
  });
  const supervisor = new JobSupervisor(runner, { statusStore: store });

  const terminal = await supervisor.start(spec("job_progress_fail", { mode: "work" }));
  assert.deepEqual(hookErrors, [progressError, progressError]);
  assert.equal(terminal.status, "ambiguous");
  assert.equal(terminal.error, "progress write failed");
  assert.equal(terminal.result, undefined);
});
