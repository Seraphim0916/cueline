import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  BrowserTurnInput,
  ControllerTurn,
} from "../../src/browser/browser-adapter.js";
import {
  cancelCueLineJob,
  cancelCueLineRun,
  continueCueLineRun,
  loadCueLineRunStatus,
  submitCueLineCallerJobResult,
  takeoverCueLineRuntime,
} from "../../src/api.js";
import { jobId } from "../../src/core/ids.js";
import { initialRunState, reduceRunState } from "../../src/core/state-machine.js";
import { JobStatusStore } from "../../src/jobs/status.js";
import type { ControllerJobSpec } from "../../src/protocol/types.js";
import { readEvents } from "../../src/state/event-log.js";
import { runPaths } from "../../src/state/paths.js";
import { RunStore } from "../../src/state/store.js";
import { FakeBrowserAdapter } from "../fakes/fake-browser.js";

const DEAD_PID = 2_147_483_647;

async function temporaryHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "cueline-lifecycle-"));
}

function completeReply(
  input: BrowserTurnInput,
  finalDeliveryText: string,
): ControllerTurn {
  return {
    text: `<CueLineControl>${JSON.stringify({
      protocol: "cueline/0.1",
      run_id: input.runId,
      round: input.round,
      request_id: input.requestId,
      action: "complete",
      final_delivery_text: finalDeliveryText,
    })}</CueLineControl>`,
    conversationUrl: "https://chatgpt.com/c/lifecycle-recovery",
    model: {
      provider: "chatgpt",
      selectedLabel: "Pro",
      responseModelSlug: "gpt-5-6-pro",
      source: "composer_and_response",
    },
  };
}

async function createJobRun(
  home: string,
  runId: string,
  executor: "caller" | "process",
  options: { failed?: boolean; persistedStatus?: "pending" | "running" } = {},
): Promise<{ jobId: string; spec: ControllerJobSpec; store: RunStore<ReturnType<typeof initialRunState>> }> {
  const spec: ControllerJobSpec = {
    job_key: "lifecycle_job",
    lane: "default",
    mode: "advise",
    task: "Prove lifecycle convergence",
  };
  const id = jobId(runId, spec.job_key, spec);
  const store = await RunStore.create({
    home,
    runId,
    initialState: initialRunState(runId, "", executor),
    reducer: reduceRunState,
  });
  await store.append("run_created", {
    request: "Exercise lifecycle recovery",
    executor,
  });
  await store.append("job_registered", {
    job: {
      jobId: id,
      jobKey: spec.job_key,
      required: true,
      spec,
      status: options.persistedStatus ?? "running",
      output: null,
      error: null,
    },
  });
  if (options.failed) {
    await store.append("run_failed", {
      code: "OUTER_OWNER_DIED",
      message: "The outer owner disappeared before job convergence.",
      stage: "controller_loop",
    });
  }
  await store.snapshot();
  await new JobStatusStore(home).write({
    jobId: id,
    runId,
    jobKey: spec.job_key,
    lane: spec.lane,
    mode: spec.mode,
    ...(executor === "process" ? { pid: DEAD_PID } : {}),
    execution: "foreground",
    status: options.persistedStatus ?? "running",
    startedAt: "2026-07-15T00:00:00.000Z",
  });
  return { jobId: id, spec, store };
}

async function writeDeadLease(
  home: string,
  runId: string,
  ownership: "active" | "stale",
): Promise<void> {
  const timestamp =
    ownership === "active"
      ? new Date().toISOString()
      : "2026-07-14T00:00:00.000Z";
  await writeFile(
    runPaths(home, runId).runtimeLease,
    `${JSON.stringify({
      protocol: "cueline/runtime-lease/0.1",
      run_id: runId,
      owner_id: "definitely-dead-owner",
      pid: String(DEAD_PID),
      state: "active",
      claimed_at: timestamp,
      heartbeat_at: timestamp,
    })}\n`,
    "utf8",
  );
}

function succeededStatus(
  runId: string,
  jobIdValue: string,
  spec: ControllerJobSpec,
  output: string,
) {
  const timestamp = "2026-07-15T00:00:01.000Z";
  return {
    jobId: jobIdValue,
    runId,
    jobKey: spec.job_key,
    lane: spec.lane,
    mode: spec.mode,
    pid: DEAD_PID,
    execution: "foreground" as const,
    status: "succeeded" as const,
    startedAt: timestamp,
    finishedAt: timestamp,
    result: {
      status: "succeeded" as const,
      exitCode: 0,
      stdout: output,
      stderr: "",
      output,
      emptyOutput: false,
      timedOut: false,
      cancelled: false,
      ambiguousSideEffects: false,
      retryable: false as const,
      startedAt: timestamp,
      finishedAt: timestamp,
    },
  };
}

const routingConfig = {
  version: 1 as const,
  lanes: {
    default: {
      enabled: true,
      candidates: [
        {
          id: "node",
          argv: [process.execPath, "-e", "process.stdout.write('unused')"],
          task_input: "stdin" as const,
        },
      ],
    },
  },
};

test("run cancellation retires a fresh lease whose PID is definitely dead", async () => {
  const home = await temporaryHome();
  const runId = "run_cancel_fresh_dead_owner";
  const fixture = await createJobRun(home, runId, "process");
  await writeDeadLease(home, runId, "active");

  const result = await cancelCueLineRun(runId, { home });

  assert.equal(result.outcome, "cancelled");
  assert.equal(result.affectedJobs, 1);
  assert.equal((await new JobStatusStore(home).read(fixture.jobId))?.status, "ambiguous");
  assert.equal((await loadCueLineRunStatus(runId, { home })).status, "cancelled");
});

test("job cancellation retires a stale lease whose PID is definitely dead", async () => {
  const home = await temporaryHome();
  const runId = "run_job_cancel_fresh_dead_owner";
  const fixture = await createJobRun(home, runId, "process");
  await writeDeadLease(home, runId, "stale");

  const result = await cancelCueLineJob(runId, fixture.jobId, { home });

  assert.equal(result.outcome, "ambiguous");
  assert.equal((await new JobStatusStore(home).read(fixture.jobId))?.status, "ambiguous");
});

test("ownerless cancellation stays pending while the persisted process group is alive", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process-group liveness is required");
    return;
  }
  const home = await temporaryHome();
  const runId = "run_cancel_live_ownerless_group";
  const fixture = await createJobRun(home, runId, "process");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
    detached: true,
    stdio: "ignore",
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("detached test process has no PID");
  child.unref();
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  await new JobStatusStore(home).write({
    jobId: fixture.jobId,
    runId,
    jobKey: fixture.spec.job_key,
    lane: fixture.spec.lane,
    mode: fixture.spec.mode,
    pid,
    execution: "background",
    status: "running",
    startedAt: "2026-07-15T00:00:00.000Z",
  });

  try {
    const result = await cancelCueLineRun(runId, { home });
    assert.deepEqual(result, { runId, outcome: "requested", affectedJobs: 0 });
    const state = await loadCueLineRunStatus(runId, { home });
    assert.equal(state.status, "running");
    const persisted = await new JobStatusStore(home).read(fixture.jobId);
    assert.equal(persisted?.status, "running");
    assert.equal(persisted?.pid, pid);
    assert.doesNotThrow(() => process.kill(-pid, 0));
  } finally {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The child may have exited independently; cleanup remains best effort.
    }
  }
});

test("explicit stale takeover releases a shared live-host owner, audits it, and permits caller continuation", async () => {
  const home = await temporaryHome();
  const runId = "run_explicit_stale_takeover";
  const store = await RunStore.create({
    home,
    runId,
    initialState: initialRunState(runId, "", "caller"),
    reducer: reduceRunState,
  });
  await store.append("run_created", {
    request: "Resume after a shared Node host lost the outer caller",
    executor: "caller",
  });
  const heartbeatAt = "2026-07-15T00:00:00.000Z";
  await writeFile(
    runPaths(home, runId).runtimeLease,
    `${JSON.stringify({
      protocol: "cueline/runtime-lease/0.1",
      run_id: runId,
      owner_id: "shared-live-host-owner",
      pid: String(process.pid),
      state: "active",
      claimed_at: heartbeatAt,
      heartbeat_at: heartbeatAt,
    })}\n`,
    "utf8",
  );
  const now = () => new Date("2026-07-15T00:01:00.000Z");

  const takeover = await takeoverCueLineRuntime(runId, { home, now });

  assert.equal(takeover.outcome, "taken_over");
  assert.equal(takeover.next, "continue");
  assert.equal((await loadCueLineRunStatus(runId, { home, now })).runtime.ownership, "missing");
  const events = await readEvents(runPaths(home, runId).events);
  assert.deepEqual(
    events
      .filter((event) => event.type.startsWith("runtime_stale_owner_takeover_"))
      .map((event) => event.type),
    [
      "runtime_stale_owner_takeover_requested",
      "runtime_stale_owner_takeover_confirmed",
    ],
  );
  const result = await continueCueLineRun({
    runId,
    home,
    now,
    browser: new FakeBrowserAdapter([
      (input) => completeReply(input, "TAKEOVER_CONTINUED"),
    ]),
    routingConfig,
  });
  assert.equal(result.status, "complete");
  assert.equal(result.finalDeliveryText, "TAKEOVER_CONTINUED");
});

test("concurrent explicit takeovers record attempts safely but only one confirmed success", async () => {
  const home = await temporaryHome();
  const runId = "run_concurrent_explicit_takeover";
  const store = await RunStore.create({
    home,
    runId,
    initialState: initialRunState(runId, "", "caller"),
    reducer: reduceRunState,
  });
  await store.append("run_created", {
    request: "Only one stale takeover may succeed",
    executor: "caller",
  });
  const heartbeatAt = "2026-07-15T00:00:00.000Z";
  await writeFile(
    runPaths(home, runId).runtimeLease,
    `${JSON.stringify({
      protocol: "cueline/runtime-lease/0.1",
      run_id: runId,
      owner_id: "concurrent-stale-owner",
      pid: String(process.pid),
      state: "active",
      claimed_at: heartbeatAt,
      heartbeat_at: heartbeatAt,
    })}\n`,
    "utf8",
  );
  const now = () => new Date("2026-07-15T00:01:00.000Z");

  const attempts = await Promise.allSettled([
    takeoverCueLineRuntime(runId, { home, now }),
    takeoverCueLineRuntime(runId, { home, now }),
  ]);

  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  const rejected = attempts.find(
    (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
  );
  assert.equal(
    rejected?.reason instanceof Error &&
      "code" in rejected.reason &&
      rejected.reason.code === "RUNTIME_TAKEOVER_RACE",
    true,
  );
  const events = await readEvents(runPaths(home, runId).events);
  assert.equal(
    events.filter((event) => event.type === "runtime_stale_owner_takeover_requested").length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === "runtime_stale_owner_takeover_confirmed").length,
    1,
  );
  assert.deepEqual(
    events.map((event) => event.sequence),
    Array.from({ length: events.length }, (_, index) => index + 1),
  );
  assert.equal(
    (
      await readdir(`${runPaths(home, runId).runtimeLease}.takeover-intents`)
    ).filter((name) => name.endsWith(".json")).length,
    2,
  );
});

test("run cancellation retry repairs a stale job status left by event-first interruption", async () => {
  const home = await temporaryHome();
  const runId = "run_cancel_repairs_status";
  const fixture = await createJobRun(home, runId, "caller", { persistedStatus: "pending" });
  const error = "Caller job was cancelled before execution evidence was submitted.";
  await fixture.store.append("job_status", {
    job_id: fixture.jobId,
    status: "cancelled",
    error,
  });
  await fixture.store.append("run_cancelled", { reason: "interrupted cancellation" });
  await fixture.store.snapshot();

  const result = await cancelCueLineRun(runId, { home });

  assert.equal(result.outcome, "already_terminal");
  const persisted = await new JobStatusStore(home).read(fixture.jobId);
  assert.equal(persisted?.status, "cancelled");
  assert.equal(persisted?.error, error);
});

test("job cancellation retry repairs a stale job status left by event-first interruption", async () => {
  const home = await temporaryHome();
  const runId = "run_job_cancel_repairs_status";
  const fixture = await createJobRun(home, runId, "caller", { persistedStatus: "pending" });
  const error = "Caller job was cancelled before execution evidence was submitted.";
  await fixture.store.append("job_status", {
    job_id: fixture.jobId,
    status: "cancelled",
    error,
  });
  await fixture.store.snapshot();

  const result = await cancelCueLineJob(runId, fixture.jobId, { home });

  assert.equal(result.outcome, "already_terminal");
  const persisted = await new JobStatusStore(home).read(fixture.jobId);
  assert.equal(persisted?.status, "cancelled");
  assert.equal(persisted?.error, error);
});

test("cancellation rejects blank reasons before writing an unreadable request", async () => {
  const home = await temporaryHome();
  const runId = "run_cancel_blank_reason";
  const fixture = await createJobRun(home, runId, "caller", { persistedStatus: "pending" });

  await assert.rejects(
    cancelCueLineRun(runId, { home, reason: "   " }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CANCELLATION_REASON_INVALID",
  );
  await assert.rejects(
    cancelCueLineJob(runId, fixture.jobId, { home, reason: "" }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CANCELLATION_REASON_INVALID",
  );
  const status = await loadCueLineRunStatus(runId, { home });
  assert.equal(status.cancellation.runRequested, false);
  assert.deepEqual(status.cancellation.jobRequests, []);
});

test("run cancellation imports status-first terminal evidence without overwriting it", async () => {
  const home = await temporaryHome();
  const runId = "run_cancel_status_first_terminal";
  const fixture = await createJobRun(home, runId, "process");
  const terminal = succeededStatus(runId, fixture.jobId, fixture.spec, "VALID_RUN_RESULT");
  await new JobStatusStore(home).write(terminal);

  const result = await cancelCueLineRun(runId, { home });

  assert.equal(result.outcome, "cancelled");
  const persisted = await new JobStatusStore(home).read(fixture.jobId);
  assert.equal(persisted?.status, "succeeded");
  assert.equal(persisted?.result?.stdout, "VALID_RUN_RESULT");
  const reloaded = await RunStore.load({
    home,
    runId,
    initialState: initialRunState(runId, "", "process"),
    reducer: reduceRunState,
  });
  assert.equal(reloaded.state.jobs[fixture.jobId]?.status, "succeeded");
  assert.equal(reloaded.state.jobs[fixture.jobId]?.output, "VALID_RUN_RESULT");
});

test("job cancellation imports status-first terminal evidence without overwriting it", async () => {
  const home = await temporaryHome();
  const runId = "run_job_cancel_status_first_terminal";
  const fixture = await createJobRun(home, runId, "process");
  const terminal = succeededStatus(runId, fixture.jobId, fixture.spec, "VALID_JOB_RESULT");
  await new JobStatusStore(home).write(terminal);

  const result = await cancelCueLineJob(runId, fixture.jobId, { home });

  assert.equal(result.outcome, "already_terminal");
  const persisted = await new JobStatusStore(home).read(fixture.jobId);
  assert.equal(persisted?.status, "succeeded");
  assert.equal(persisted?.result?.stdout, "VALID_JOB_RESULT");
  const reloaded = await RunStore.load({
    home,
    runId,
    initialState: initialRunState(runId, "", "process"),
    reducer: reduceRunState,
  });
  assert.equal(reloaded.state.jobs[fixture.jobId]?.status, "succeeded");
  assert.equal(reloaded.state.jobs[fixture.jobId]?.output, "VALID_JOB_RESULT");
});

test("a crash after response receipt reconciles that response instead of sending a new round", async () => {
  const home = await temporaryHome();
  const runId = "run_response_received_before_acceptance_crash";
  const requestId = "msg_response_received_before_acceptance_crash";
  const conversationUrl = "https://chatgpt.com/c/response-before-acceptance";
  const responseText = `<CueLineControl>${JSON.stringify({
    protocol: "cueline/0.1",
    run_id: runId,
    round: 1,
    request_id: requestId,
    action: "complete",
    final_delivery_text: "RECOVERED_EXISTING_RESPONSE",
  })}</CueLineControl>`;
  const store = await RunStore.create({
    home,
    runId,
    initialState: initialRunState(runId, "", "caller"),
    reducer: reduceRunState,
  });
  await store.append("run_created", { request: "Do not resend received response", executor: "caller" });
  await store.append("controller_turn_requested", {
    round: 1,
    request_id: requestId,
    prompt: "original controller prompt",
    prompt_hash: "original-controller-prompt-hash",
  });
  await store.append("controller_turn_submitted", {
    round: 1,
    request_id: requestId,
    submission_state: "submitted",
    conversation_url: conversationUrl,
    selected_model_label: "Pro",
    composer_prompt_state: "inline_ready",
    baseline_assistant_message_count: 0,
  });
  await store.append("controller_response_received", {
    round: 1,
    request_id: requestId,
    text: responseText,
    conversation_url: conversationUrl,
    selected_model_label: "Pro",
    response_model_slug: "gpt-5-6-pro",
    model_evidence_source: "composer_and_response",
  });
  await store.append("run_failed", {
    code: "INJECTED_AFTER_RESPONSE_RECEIPT",
    message: "runtime stopped before command acceptance",
    stage: "controller_response",
  });
  await store.snapshot();
  assert.equal(store.state.pendingControllerTurns[0]?.requestId, requestId);

  let sendCalls = 0;
  let recoverCalls = 0;
  const browser = {
    async sendTurn(): Promise<ControllerTurn> {
      sendCalls += 1;
      throw new Error("must recover the received response instead of sending");
    },
    async recoverTurn(): Promise<ControllerTurn> {
      recoverCalls += 1;
      return {
        text: responseText,
        conversationUrl,
        model: {
          provider: "chatgpt" as const,
          selectedLabel: "Pro",
          responseModelSlug: "gpt-5-6-pro",
          source: "composer_and_response" as const,
        },
      };
    },
  };
  const result = await continueCueLineRun({
    runId,
    home,
    browser,
    conversationUrl,
    routingConfig,
  });

  assert.equal(result.status, "complete");
  assert.equal(result.finalDeliveryText, "RECOVERED_EXISTING_RESPONSE");
  assert.equal(sendCalls, 0);
  assert.equal(recoverCalls, 1);
  const events = await readEvents(runPaths(home, runId).events);
  assert.equal(events.filter((event) => event.type === "controller_command_accepted").length, 1);
  assert.equal(events.filter((event) => event.type === "controller_turn_requested").length, 1);
});

test("caller result input is fully validated before any durable write", async () => {
  const home = await temporaryHome();
  const runId = "run_missing_for_invalid_caller_result";
  const jobIdValue = "job_invalid_caller_result";
  const invalidInputs: unknown[] = [
    null,
    { status: "unknown" },
    { status: "succeeded", stdout: 7 },
    { status: "succeeded", stderr: {} },
    { status: "succeeded", output: [] },
    { status: "failed", error: 42 },
    { status: "succeeded", startedAt: 1 },
    { status: "succeeded", finishedAt: false },
    { status: "succeeded", exitCode: 1.5 },
  ];
  for (const input of invalidInputs) {
    await assert.rejects(
      submitCueLineCallerJobResult(
        runId,
        jobIdValue,
        input as Parameters<typeof submitCueLineCallerJobResult>[2],
        { home },
      ),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error.code === "CALLER_JOB_RESULT_INVALID" ||
          error.code === "CALLER_JOB_STATUS_INVALID"),
    );
  }
  assert.equal(await new JobStatusStore(home).read(jobIdValue), undefined);
});

test("continuation reconciles ownerless active process jobs even after the run failed", async () => {
  const home = await temporaryHome();
  const runId = "run_failed_ownerless_active_job";
  const fixture = await createJobRun(home, runId, "process", { failed: true });
  const browser = new FakeBrowserAdapter([
    (input) => {
      assert.match(input.prompt, /worker process disappeared/i);
      return completeReply(input, "FAILED_OWNER_RECONCILED");
    },
  ]);

  const result = await continueCueLineRun({
    runId,
    home,
    browser,
    routingConfig,
  });

  assert.equal(result.status, "complete");
  assert.equal(result.state.jobs[fixture.jobId]?.status, "failed");
  assert.equal(result.finalDeliveryText, "FAILED_OWNER_RECONCILED");
});
