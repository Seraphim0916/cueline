import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { BrowserAdapter } from "../../src/browser/browser-adapter.js";
import {
  executeAcceptedCommand,
  statusPayload,
  validateCommandBeforeAcceptance,
} from "../../src/core/controller-command-execution.js";
import { controllerEvidenceContentHash } from "../../src/core/controller-turn.js";
import type {
  ControllerRuntimeOptions,
  JobSupervisorLike,
} from "../../src/core/controller-types.js";
import { CueLineError } from "../../src/core/errors.js";
import { jobId } from "../../src/core/ids.js";
import {
  initialRunState,
  reduceRunState,
  type CueLineExecutor,
  type CueLineRunState,
} from "../../src/core/state-machine.js";
import { JobStatusStore, type JobStatus } from "../../src/jobs/status.js";
import {
  CUELINE_PROTOCOL,
  type ControllerCommand,
  type ControllerJobSpec,
  type JobObservation,
} from "../../src/protocol/types.js";
import type { JobResult, RunnerSpec } from "../../src/runners/runner-adapter.js";
import { readEvents } from "../../src/state/event-log.js";
import { RunStore } from "../../src/state/store.js";

const NOW = new Date("2026-10-26T00:00:00.000Z");

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof CueLineError && error.code === code;
}

async function createStore(
  executor: CueLineExecutor,
  runId = `run_cmd_${executor}`,
): Promise<RunStore<CueLineRunState>> {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-unit-cmd-"));
  return RunStore.create({
    home,
    runId,
    initialState: initialRunState(runId, "", executor, null, executor === "process"),
    reducer: reduceRunState,
    now: () => NOW,
  });
}

function base(): { protocol: typeof CUELINE_PROTOCOL; run_id: string; round: number; request_id: string } {
  return { protocol: CUELINE_PROTOCOL, run_id: "run", round: 1, request_id: "req_1" };
}

function dispatch(jobs: ControllerJobSpec[]): ControllerCommand {
  return { ...base(), action: "dispatch", jobs };
}

function advise(jobKey: string, overrides: Partial<ControllerJobSpec> = {}): ControllerJobSpec {
  return { job_key: jobKey, lane: "default", mode: "advise", task: `task ${jobKey}`, ...overrides };
}

function result(output: string, status: JobResult["status"] = "succeeded"): JobResult {
  return {
    status,
    exitCode: status === "succeeded" ? 0 : 1,
    stdout: output,
    stderr: "",
    output,
    emptyOutput: output.length === 0,
    timedOut: status === "timed_out",
    cancelled: status === "cancelled",
    ambiguousSideEffects: false,
    retryable: false,
    startedAt: NOW.toISOString(),
    finishedAt: NOW.toISOString(),
  };
}

function terminal(id: string, output = `done ${id}`): JobStatus {
  return {
    jobId: id,
    execution: "foreground",
    status: "succeeded",
    startedAt: NOW.toISOString(),
    finishedAt: NOW.toISOString(),
    result: result(output),
  };
}

function running(id: string): JobStatus {
  return { jobId: id, execution: "background", status: "running", startedAt: NOW.toISOString() };
}

class ScriptedSupervisor implements JobSupervisorLike {
  readonly calls: string[] = [];
  active = 0;
  maxActive = 0;

  constructor(
    private readonly handlers: {
      start?: (spec: RunnerSpec) => Promise<JobStatus>;
      wait?: (jobId: string) => Promise<JobStatus>;
      inspect?: (jobId: string) => Promise<JobStatus>;
    } = {},
  ) {}

  async start(spec: RunnerSpec): Promise<JobStatus> {
    this.calls.push(`start:${spec.jobKey ?? spec.jobId}`);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      return await (this.handlers.start ?? (async (runner) => terminal(runner.jobId)))(spec);
    } finally {
      this.active -= 1;
    }
  }

  async waitForCompletion(id: string): Promise<JobStatus> {
    this.calls.push(`wait:${id}`);
    return (this.handlers.wait ?? (async (jobIdentity) => terminal(jobIdentity)))(id);
  }

  async inspect(id: string): Promise<JobStatus> {
    this.calls.push(`inspect:${id}`);
    return (this.handlers.inspect ?? (async (jobIdentity) => terminal(jobIdentity)))(id);
  }
}

function options(
  supervisor: JobSupervisorLike = new ScriptedSupervisor(),
  overrides: Partial<ControllerRuntimeOptions> = {},
): ControllerRuntimeOptions & { resolved: string[] } {
  const resolved: string[] = [];
  return {
    browser: {} as BrowserAdapter,
    jobSupervisor: supervisor,
    resolveRunnerSpec: (id, spec) => {
      resolved.push(spec.job_key);
      return { jobId: id, argv: ["worker"], mode: spec.mode, timeoutMs: 1_000, runnerId: "worker", ...(spec.background === undefined ? {} : { background: spec.background }) };
    },
    now: () => NOW,
    resolved,
    ...overrides,
  };
}

async function eventTypes(store: RunStore<CueLineRunState>): Promise<string[]> {
  return (await readEvents(store.paths.events)).map((event) => event.type);
}

test("statusPayload maps optional runtime fields and bounds evidence", () => {
  const full: JobStatus = {
    ...terminal("job_x", "x".repeat(50)),
    runnerId: "worker",
    pid: 12,
    model: "m",
    provider: "p",
    phase: "completed",
    lastProgressAt: NOW.toISOString(),
    error: "e".repeat(50),
  };
  const payload = statusPayload(full, 10);
  assert.equal(payload.job_id, "job_x");
  assert.equal(payload.status, "succeeded");
  assert.equal(payload.runner_id, "worker");
  assert.equal(payload.pid, 12);
  assert.equal(payload.model, "m");
  assert.equal(payload.provider, "p");
  assert.equal(payload.phase, "completed");
  assert.equal(payload.last_progress_at, NOW.toISOString());
  assert.equal(payload.output_total_chars, 50);
  assert.equal(payload.error_total_chars, 50);
  assert.equal(
    payload.output,
    `${"x".repeat(10)}\n...[job evidence capped: 40 chars omitted; total_chars=50; cap=10]`,
  );
  assert.ok((payload.error as string).startsWith(`${"e".repeat(10)}\n...[job evidence capped`));

  const bare = statusPayload(running("job_y"), 10);
  assert.deepEqual(Object.keys(bare).sort(), ["job_id", "status"]);
});

test("wait and inspect reject unknown job targets with a bounded, de-duplicated preview", async () => {
  const store = await createStore("caller");
  const opts = options();
  const long = `job_${"z".repeat(200)}`;
  for (const action of ["wait", "inspect"] as const) {
    assert.throws(
      () =>
        validateCommandBeforeAcceptance(store, { ...base(), action, job_ids: ["job_a", "job_a"] }, opts),
      (error: unknown) =>
        hasCode("CONTROL_JOB_TARGET_UNKNOWN")(error) &&
        /unknown job ID: "job_a"\./.test((error as Error).message) &&
        (error as CueLineError & { details: { unknown_job_count: number } }).details.unknown_job_count === 1,
    );
  }
  assert.throws(
    () =>
      validateCommandBeforeAcceptance(
        store,
        { ...base(), action: "wait", job_ids: [long, "job_b", "job_c", "job_d", "job_e"] },
        opts,
      ),
    (error: unknown) => {
      const message = (error as Error).message;
      return (
        hasCode("CONTROL_JOB_TARGET_UNKNOWN")(error) &&
        message.includes("unknown job IDs:") &&
        message.includes("(+2 more)") &&
        message.includes(JSON.stringify(long.slice(0, 128))) &&
        !message.includes(long)
      );
    },
  );
  // Commands without explicit targets are not checked.
  validateCommandBeforeAcceptance(store, { ...base(), action: "wait" }, opts);
});

test("paginated inspect requires a known job with evidence and the exact evidence hash", async () => {
  const store = await createStore("caller");
  await executeAcceptedCommand(store, dispatch([advise("audit")]), "hash_dispatch", options());
  const id = Object.keys(store.state.jobs)[0]!;
  const opts = options();
  const inspect = (hash: string): ControllerCommand => ({
    ...base(),
    action: "inspect",
    job_ids: [id],
    evidence_offset: 0,
    evidence_hash: hash,
  });
  const observation = (fields: Partial<JobObservation>): JobObservation[] => [
    { job_id: id, job_key: "audit", required: true, status: "succeeded", ...fields },
  ];

  assert.throws(
    () => validateCommandBeforeAcceptance(store, inspect("h"), opts, []),
    hasCode("CONTROL_INSPECT_JOB_UNKNOWN"),
  );
  assert.throws(
    () => validateCommandBeforeAcceptance(store, inspect("h"), opts, observation({})),
    hasCode("CONTROL_INSPECT_EVIDENCE_UNAVAILABLE"),
  );
  assert.throws(
    () => validateCommandBeforeAcceptance(store, inspect("wrong"), opts, observation({ output: "out" })),
    hasCode("CONTROL_INSPECT_EVIDENCE_HASH_MISMATCH"),
  );
  // A succeeded job without output falls back to its error evidence.
  const errorHash = controllerEvidenceContentHash({ field: "error", value: "boom" });
  validateCommandBeforeAcceptance(store, inspect(errorHash), opts, observation({ error: "boom" }));
  const outputHash = controllerEvidenceContentHash({ field: "output", value: "out" });
  validateCommandBeforeAcceptance(store, inspect(outputHash), opts, observation({ output: "out", error: "boom" }));
});

test("caller work dispatch requires an absolute workdir and foreground execution", async () => {
  const store = await createStore("caller");
  const opts = options();
  const work = (overrides: Partial<ControllerJobSpec>): ControllerCommand =>
    dispatch([advise("work", { mode: "work", ...overrides })]);

  assert.throws(() => validateCommandBeforeAcceptance(store, work({}), opts), hasCode("CALLER_WORKDIR_REQUIRED"));
  assert.throws(
    () => validateCommandBeforeAcceptance(store, work({ workdir: "relative/dir" }), opts),
    hasCode("CALLER_WORKDIR_REQUIRED"),
  );
  assert.throws(
    () => validateCommandBeforeAcceptance(store, work({ workdir: tmpdir(), background: true }), opts),
    hasCode("CALLER_WORK_BACKGROUND_UNSUPPORTED"),
  );
  validateCommandBeforeAcceptance(store, work({ workdir: tmpdir() }), opts);
  // Advice needs no workdir, and caller mode never resolves process runners.
  validateCommandBeforeAcceptance(store, dispatch([advise("advice")]), opts);
  assert.deepEqual(opts.resolved, []);
});

test("process dispatch validation runs the spec hook, resolves only new jobs, and rejects key reuse", async () => {
  const store = await createStore("process");
  const validated: string[] = [];
  const opts = options(new ScriptedSupervisor(), {
    validateJobSpec: (spec) => {
      validated.push(spec.job_key);
      if (spec.task === "forbidden") throw new CueLineError("SPEC_REJECTED", "no");
    },
  });
  // Process executors may run work without a workdir.
  validateCommandBeforeAcceptance(store, dispatch([advise("work", { mode: "work" })]), opts);
  assert.deepEqual(opts.resolved, ["work"]);
  assert.throws(
    () => validateCommandBeforeAcceptance(store, dispatch([advise("bad", { task: "forbidden" })]), opts),
    hasCode("SPEC_REJECTED"),
  );

  await executeAcceptedCommand(store, dispatch([advise("audit")]), "hash_a", options());
  opts.resolved.length = 0;
  validateCommandBeforeAcceptance(store, dispatch([advise("audit")]), opts);
  assert.deepEqual(opts.resolved, []);
  assert.throws(
    () => validateCommandBeforeAcceptance(store, dispatch([advise("audit", { task: "changed" })]), opts),
    hasCode("JOB_KEY_IDENTITY_MISMATCH"),
  );
  assert.deepEqual(validated, ["work", "bad", "audit", "audit"]);
});

test("caller dispatch registers pending jobs once and hands them back to the caller", async () => {
  const store = await createStore("caller");
  const work = advise("work", { mode: "work", workdir: tmpdir() });
  const outcome = await executeAcceptedCommand(
    store,
    dispatch([advise("audit"), work]),
    "hash_caller",
    options(),
  );
  assert.equal(outcome, "awaiting_caller");
  const jobs = Object.values(store.state.jobs);
  assert.deepEqual(jobs.map((job) => [job.jobKey, job.status]).sort(), [["audit", "pending"], ["work", "pending"]]);
  assert.deepEqual(store.state.jobs[jobId(store.runId, "work", work)]?.callerWork, {
    claim: null,
    nextFencingToken: 0,
  });
  assert.equal(store.state.jobs[jobId(store.runId, "audit", advise("audit"))]?.callerWork, undefined);
  const statusStore = new JobStatusStore(store.paths.home);
  for (const job of jobs) {
    const persisted = await statusStore.read(job.jobId);
    assert.equal(persisted?.status, "pending");
    assert.equal(persisted?.runId, store.runId);
    assert.equal(persisted?.startedAt, NOW.toISOString());
  }

  const again = await executeAcceptedCommand(store, dispatch([advise("audit")]), "hash_again", options());
  assert.equal(again, "awaiting_caller");
  assert.ok(store.state.notices.some((notice) => notice.startsWith("duplicate dispatch ignored for job_key 'audit'")));
  assert.equal(store.state.pendingCommandExecution ?? null, null);
  const types = await eventTypes(store);
  assert.equal(types.filter((type) => type === "controller_command_execution_completed").length, 2);
  assert.equal(types.filter((type) => type === "job_registered").length, 2);
});

test("caller dispatch resuming a pending execution reuses pending jobs without a duplicate notice", async () => {
  const store = await createStore("caller");
  await executeAcceptedCommand(store, dispatch([advise("audit")]), "hash_1", options());
  const notices = store.state.notices.length;
  const outcome = await executeAcceptedCommand(store, dispatch([advise("audit")]), "hash_1", options(), true);
  assert.equal(outcome, "awaiting_caller");
  assert.equal(store.state.notices.length, notices);
});

test("caller wait and inspect await the caller only while a selected job is active", async () => {
  const store = await createStore("caller");
  await executeAcceptedCommand(store, dispatch([advise("audit")]), "hash_d", options());
  const id = Object.keys(store.state.jobs)[0]!;
  for (const action of ["wait", "inspect"] as const) {
    assert.equal(await executeAcceptedCommand(store, { ...base(), action }, `h_${action}`, options()), "awaiting_caller");
    assert.equal(
      await executeAcceptedCommand(store, { ...base(), action, job_ids: [id] }, `h_${action}_id`, options()),
      "awaiting_caller",
    );
    assert.equal(
      await executeAcceptedCommand(store, { ...base(), action, job_ids: ["job_other"] }, `h_${action}_x`, options()),
      "continue",
    );
  }
});

test("caller dispatch with no new or active jobs continues", async () => {
  const store = await createStore("caller");
  assert.equal(await executeAcceptedCommand(store, dispatch([]), "hash_empty", options()), "continue");
  assert.deepEqual(store.state.jobs, {});
});

test("complete and blocked are rejected while jobs are active, then become terminal", async () => {
  const store = await createStore("caller");
  await executeAcceptedCommand(store, dispatch([advise("audit")]), "hash_d", options());
  const complete: ControllerCommand = { ...base(), action: "complete", final_delivery_text: "final" };
  const blocked: ControllerCommand = { ...base(), action: "blocked", reason: "stuck" };

  assert.equal(await executeAcceptedCommand(store, complete, "hash_c", options()), "continue");
  assert.equal(await executeAcceptedCommand(store, blocked, "hash_b", options()), "continue");
  assert.deepEqual(store.state.notices.slice(-2), [
    "complete rejected: jobs still pending or running: audit",
    "blocked rejected: jobs still pending or running: audit",
  ]);
  assert.equal(store.state.status, "running");

  const done = await createStore("caller", "run_cmd_done");
  assert.equal(await executeAcceptedCommand(done, complete, "hash_c", options()), "terminal");
  assert.equal(done.state.status, "complete");

  for (const [runId, command] of [
    ["run_cmd_blocked", blocked],
    ["run_cmd_blocked_text", { ...blocked, final_delivery_text: "partial" }],
  ] as const) {
    const halted = await createStore("caller", runId);
    assert.equal(await executeAcceptedCommand(halted, command, "hash_b", options()), "terminal");
    assert.equal(halted.state.status, "blocked");
    const event = (await readEvents(halted.paths.events)).find((entry) => entry.type === "run_blocked");
    const payload = event?.payload as { reason?: string; final_delivery_text?: string } | undefined;
    assert.equal(payload?.reason, "stuck");
    assert.equal(payload?.final_delivery_text, "final_delivery_text" in command ? "partial" : undefined);
  }
});

test("process dispatch starts jobs, records terminal evidence and persists the durable status", async () => {
  const store = await createStore("process");
  const supervisor = new ScriptedSupervisor();
  const outcome = await executeAcceptedCommand(store, dispatch([advise("audit")]), "hash_p", options(supervisor));
  assert.equal(outcome, "continue");
  const id = jobId(store.runId, "audit", advise("audit"));
  const job = store.state.jobs[id];
  assert.equal(job?.status, "succeeded");
  assert.equal(job?.output, `done ${id}`);
  assert.equal(job?.runtime?.runnerId, "worker");
  const persisted = await new JobStatusStore(store.paths.home).read(id);
  assert.equal(persisted?.status, "succeeded");
  assert.equal(persisted?.runId, store.runId);
  assert.equal(persisted?.jobKey, "audit");
  assert.equal(persisted?.lane, "default");
  assert.equal(persisted?.mode, "advise");
});

test("process dispatch records runner resolution and start failures as failed jobs", async () => {
  const store = await createStore("process");
  const supervisor = new ScriptedSupervisor({
    start: async () => {
      throw new Error("spawn refused");
    },
  });
  const opts = options(supervisor);
  const resolveRunnerSpec = opts.resolveRunnerSpec;
  opts.resolveRunnerSpec = (id, spec) => {
    if (spec.job_key === "unroutable") throw new CueLineError("ROUTE_LANE_UNKNOWN", "no lane");
    return resolveRunnerSpec(id, spec);
  };
  await executeAcceptedCommand(store, dispatch([advise("unroutable"), advise("broken")]), "hash_f", opts);

  const unroutable = store.state.jobs[jobId(store.runId, "unroutable", advise("unroutable"))];
  assert.equal(unroutable?.status, "failed");
  assert.equal(unroutable?.error, "no lane");
  const broken = store.state.jobs[jobId(store.runId, "broken", advise("broken"))];
  assert.equal(broken?.status, "failed");
  assert.equal(broken?.error, "spawn refused");
});

test("process dispatch honours the global concurrency limit", async () => {
  const store = await createStore("process");
  const supervisor = new ScriptedSupervisor({
    start: async (spec) => {
      await new Promise((resolve) => setImmediate(resolve));
      return terminal(spec.jobId);
    },
  });
  await executeAcceptedCommand(
    store,
    dispatch([advise("a"), advise("b"), advise("c")]),
    "hash_c",
    options(supervisor, { maxConcurrency: 1 }),
  );
  assert.equal(supervisor.maxActive, 1);
  assert.deepEqual(supervisor.calls, ["start:a", "start:b", "start:c"]);
  assert.ok(Object.values(store.state.jobs).every((job) => job.status === "succeeded"));
});

test("a lane with zero capacity is a concurrency deadlock", async () => {
  const store = await createStore("process");
  await assert.rejects(
    executeAcceptedCommand(store, dispatch([advise("a")]), "hash_z", options(new ScriptedSupervisor(), {
      laneConcurrency: { default: 0 },
    })),
    hasCode("JOB_CONCURRENCY_DEADLOCK"),
  );
});

test("a work job that starts running is awaited to its terminal status", async () => {
  const store = await createStore("process");
  const supervisor = new ScriptedSupervisor({ start: async (spec) => running(spec.jobId) });
  const work = advise("work", { mode: "work" });
  await executeAcceptedCommand(store, dispatch([work]), "hash_w", options(supervisor));
  const id = jobId(store.runId, "work", work);
  assert.deepEqual(supervisor.calls, ["start:work", `wait:${id}`]);
  assert.equal(store.state.jobs[id]?.status, "succeeded");
});

test("background advice frees its slot only after its terminal status while jobs are queued", async () => {
  const store = await createStore("process");
  const bg = advise("bg", { background: true });
  const supervisor = new ScriptedSupervisor({
    start: async (spec) => (spec.jobKey === "bg" ? running(spec.jobId) : terminal(spec.jobId)),
  });
  await executeAcceptedCommand(store, dispatch([bg, advise("next")]), "hash_bg", options(supervisor, {
    maxConcurrency: 1,
  }));
  const bgId = jobId(store.runId, "bg", bg);
  assert.deepEqual(supervisor.calls, ["start:bg", `wait:${bgId}`, "start:next"]);
  assert.equal(store.state.jobs[bgId]?.status, "succeeded");
});

test("lone background advice is left running and the dispatch returns", async () => {
  const store = await createStore("process");
  const bg = advise("bg", { background: true });
  const supervisor = new ScriptedSupervisor({ start: async (spec) => running(spec.jobId) });
  assert.equal(await executeAcceptedCommand(store, dispatch([bg]), "hash_bg", options(supervisor)), "continue");
  assert.deepEqual(supervisor.calls, ["start:bg"]);
  assert.equal(store.state.jobs[jobId(store.runId, "bg", bg)]?.status, "running");
});

test("process wait settles running jobs and inspect reports failures as notices", async () => {
  const store = await createStore("process");
  const bg = advise("bg", { background: true });
  const bgId = jobId(store.runId, "bg", bg);
  await executeAcceptedCommand(store, dispatch([bg]), "hash_bg", options(
    new ScriptedSupervisor({ start: async (spec) => running(spec.jobId) }),
  ));
  assert.equal(store.state.jobs[bgId]?.status, "running");

  const waiter = new ScriptedSupervisor();
  assert.equal(
    await executeAcceptedCommand(store, { ...base(), action: "wait", job_ids: ["job_other"] }, "hash_w0", options(waiter)),
    "continue",
  );
  assert.deepEqual(waiter.calls, []);
  await executeAcceptedCommand(store, { ...base(), action: "wait" }, "hash_w", options(waiter));
  assert.deepEqual(waiter.calls, [`wait:${bgId}`]);
  assert.equal(store.state.jobs[bgId]?.status, "succeeded");

  const failing = new ScriptedSupervisor({
    inspect: async () => {
      throw new Error("status file unreadable");
    },
  });
  assert.equal(await executeAcceptedCommand(store, { ...base(), action: "inspect" }, "hash_i", options(failing)), "continue");
  assert.equal(store.state.notices.at(-1), "inspection failed for 'bg': status file unreadable");

  // A durable terminal status wins over a later supervisor report.
  const inspector = new ScriptedSupervisor({ inspect: async (id) => terminal(id, "rewritten") });
  await executeAcceptedCommand(store, { ...base(), action: "inspect", job_ids: [bgId] }, "hash_i2", options(inspector));
  assert.equal(store.state.jobs[bgId]?.output, `done ${bgId}`);
});

test("a cancelled signal stops dispatch before a job is registered", async () => {
  const store = await createStore("process");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    executeAcceptedCommand(store, dispatch([advise("a")]), "hash_x", options(new ScriptedSupervisor(), {
      signal: controller.signal,
    })),
    hasCode("RUN_CANCELLED"),
  );
  assert.deepEqual(store.state.jobs, {});
});
