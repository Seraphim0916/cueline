import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { commandHash, jobId } from "../../src/core/ids.js";
import { initialRunState, reduceRunState } from "../../src/core/state-machine.js";
import { JobStatusStore } from "../../src/jobs/status.js";
import { readEvents } from "../../src/state/event-log.js";
import { runPaths } from "../../src/state/paths.js";
import { RunStore } from "../../src/state/store.js";

const cli = fileURLToPath(new URL("../../src/cli/main.js", import.meta.url));
const packageRoot = fileURLToPath(new URL("../../..", import.meta.url));

interface Invocation {
  status: number | null;
  stdout: string;
  stderr: string;
}

function invoke(args: string[], environment: NodeJS.ProcessEnv): Invocation {
  const result = spawnSync(process.execPath, [cli, ...args], {
    env: environment,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

async function packageVersion(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  ) as { version: string };
  return manifest.version;
}

async function fixture(): Promise<{ config: string; home: string; environment: NodeJS.ProcessEnv }> {
  const directory = await mkdtemp(path.join(tmpdir(), "cueline-cli-"));
  const config = path.join(directory, "routing.json");
  const home = path.join(directory, "home");
  await writeFile(
    config,
    `${JSON.stringify({
      version: 1,
      lanes: {
        default: {
          enabled: true,
          candidates: [
            {
              id: "node",
              argv: [process.execPath, "-e", "process.stdout.write('ok')"],
              task_input: "stdin",
            },
          ],
        },
      },
    })}\n`,
    "utf8",
  );
  return {
    config,
    home,
    environment: { ...process.env, CUELINE_CONFIG: config, CUELINE_HOME: home },
  };
}

async function seedActiveRun(home: string): Promise<string> {
  const runId = "run_cli_status";
  const specs = [1, 2, 3, 4].map((index) => ({
    job_key: `audit_${index}`,
    lane: "default",
    mode: "advise" as const,
    task: `Audit ${index}`,
    required: true,
  }));
  const command = {
    protocol: "cueline/0.1" as const,
    run_id: runId,
    round: 1,
    request_id: "msg_cli_status",
    action: "dispatch" as const,
    jobs: specs,
  };
  const store = await RunStore.create({
    home,
    runId,
    initialState: initialRunState(runId, "", "process", 12, true),
    reducer: reduceRunState,
  });
  await store.append("run_created", {
    request: "Inspect a large project",
    executor: "process",
    allow_process_execution: true,
  });
  await store.append("controller_turn_requested", {
    round: 1,
    request_id: "msg_cli_status",
    prompt: "Persisted controller prompt",
    prompt_hash: "prompt-hash",
  });
  await store.append("controller_response_received", {
    request_id: "msg_cli_status",
    selected_model_label: "Pro",
    response_model_slug: "gpt-5-6-pro",
    model_evidence_source: "composer_and_response",
  });
  await store.append("controller_command_accepted", {
    command,
    command_hash: commandHash(command),
  });
  for (const [spec, status] of specs.map((spec, index) => [
    spec,
    ["timed_out", "timed_out", "timed_out", "running"][index]!,
  ] as const)) {
    const id = jobId(runId, spec.job_key, spec);
    await store.append("job_registered", {
      job: {
        jobId: id,
        jobKey: spec.job_key,
        required: true,
        spec,
        status: "pending",
        output: null,
        error: null,
      },
    });
    await store.append("job_status", { job_id: id, status });
  }
  return runId;
}

async function seedOneRunningJob(home: string, runId: string): Promise<string> {
  const store = await RunStore.create({
    home,
    runId,
    initialState: initialRunState(runId, "", "process", 12, true),
    reducer: reduceRunState,
  });
  await store.append("run_created", {
    request: "Cancel one legacy job",
    executor: "process",
    allow_process_execution: true,
  });
  const spec = {
    job_key: "legacy_job",
    lane: "default",
    mode: "advise" as const,
    task: "Inspect",
    required: true,
  };
  const id = jobId(runId, spec.job_key, spec);
  await store.append("job_registered", {
    job: {
      jobId: id,
      jobKey: spec.job_key,
      required: true,
      spec,
      status: "pending",
      output: null,
      error: null,
    },
  });
  await store.append("job_status", { job_id: id, status: "running" });
  return id;
}

test("config path prints the effective configuration path", async () => {
  const context = await fixture();
  const result = invoke(["config", "path"], context.environment);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), context.config);
});

test("api path prints an importable bundled API path", async () => {
  const context = await fixture();
  const result = invoke(["api", "path"], context.environment);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), path.join(packageRoot, "dist", "src", "api.js"));
  await access(result.stdout.trim());
});

test("routing reports the pre-spawn resolved candidate", async () => {
  const context = await fixture();
  const result = invoke(["routing"], context.environment);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^default\s+node\s+available$/m);
});

test("doctor reports caller and process readiness separately", async () => {
  const context = await fixture();
  const result = invoke(["doctor"], context.environment);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`CueLine ${await packageVersion()}`));
  assert.match(result.stdout, /status\s+ok/);
  assert.match(result.stdout, /caller_ready\s+yes/);
  assert.match(result.stdout, /caller_lanes\s+1/);
  assert.match(result.stdout, /process_available_lanes\s+1/);
  assert.match(result.stdout, new RegExp(context.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("doctor exposes a stable machine-readable report", async () => {
  const context = await fixture();
  const result = invoke(["doctor", "--json"], context.environment);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    version: await packageVersion(),
    status: "ok",
    node: {
      version: process.versions.node,
      ok: true,
      requirement: ">=22",
    },
    config: {
      path: context.config,
      valid: true,
    },
    home: context.home,
    caller: {
      ready: true,
      enabledLanes: 1,
    },
    process: {
      availableLanes: 1,
    },
    findings: [],
  });
});

test("doctor JSON remains parseable and redacted when routing config is invalid", async () => {
  const context = await fixture();
  await writeFile(context.config, "{PRIVATE_CONFIG_SENTINEL", "utf8");

  const result = invoke(["doctor", "--json"], context.environment);

  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    version: await packageVersion(),
    status: "degraded",
    node: {
      version: process.versions.node,
      ok: true,
      requirement: ">=22",
    },
    config: {
      path: context.config,
      valid: false,
      errorCode: "ROUTING_CONFIG_INVALID",
    },
    home: context.home,
    caller: {
      ready: false,
      enabledLanes: 0,
    },
    process: {
      availableLanes: 0,
    },
    findings: [
      {
        code: "ROUTING_CONFIG_INVALID",
        surface: "config",
        message: "Routing configuration could not be loaded.",
      },
    ],
  });
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /PRIVATE_CONFIG_SENTINEL/);
});

test("doctor keeps caller ready when no process executable is available", async () => {
  const context = await fixture();
  await writeFile(
    context.config,
    `${JSON.stringify({
      version: 1,
      lanes: {
        default: {
          enabled: true,
          candidates: [
            {
              id: "missing-process",
              argv: ["definitely-missing-cueline-runner"],
              task_input: "stdin",
            },
          ],
        },
      },
    })}\n`,
    "utf8",
  );

  const result = invoke(["doctor"], context.environment);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /status\s+ok/);
  assert.match(result.stdout, /caller_ready\s+yes/);
  assert.match(result.stdout, /caller_lanes\s+1/);
  assert.match(result.stdout, /process_available_lanes\s+0/);

  const jsonResult = invoke(["doctor", "--json"], context.environment);
  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  const report = JSON.parse(jsonResult.stdout) as {
    status: string;
    caller: { ready: boolean; enabledLanes: number };
    process: { availableLanes: number };
  };
  assert.equal(report.status, "ok");
  assert.deepEqual(report.caller, { ready: true, enabledLanes: 1 });
  assert.deepEqual(report.process, { availableLanes: 0 });
});

test("doctor JSON degrades with a stable finding when every caller lane is disabled", async () => {
  const context = await fixture();
  await writeFile(
    context.config,
    `${JSON.stringify({
      version: 1,
      lanes: {
        default: {
          enabled: false,
          candidates: [
            {
              id: "disabled-node",
              argv: [process.execPath, "-e", "process.stdout.write('unused')"],
              task_input: "stdin",
            },
          ],
        },
      },
    })}\n`,
    "utf8",
  );

  const result = invoke(["doctor", "--json"], context.environment);

  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout) as {
    status: string;
    caller: { ready: boolean; enabledLanes: number };
    process: { availableLanes: number };
    findings: Array<{ code: string }>;
  };
  assert.equal(report.status, "degraded");
  assert.deepEqual(report.caller, { ready: false, enabledLanes: 0 });
  assert.deepEqual(report.process, { availableLanes: 0 });
  assert.deepEqual(report.findings.map((finding) => finding.code), [
    "CALLER_LANES_UNAVAILABLE",
  ]);
});

test("jobs is read-only and reports an empty store", async () => {
  const context = await fixture();
  const result = invoke(["jobs"], context.environment);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No jobs\./);
});

test("run status refuses to call a legacy running run active without ownership evidence", async () => {
  const context = await fixture();
  const runId = await seedActiveRun(context.home);
  const jsonResult = invoke(["run", "status", runId, "--json"], context.environment);

  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  const status = JSON.parse(jsonResult.stdout) as {
    version: string;
    runId: string;
    status: string;
    phase: string;
    lastEventSequence: number;
    runtime: { ownership: string };
    controller: {
      pendingTurns: number;
      acceptedCommands: number;
      responseAccepted: boolean;
    };
    jobs: {
      total: number;
      counts: Record<string, number>;
    };
    continueAllowed: boolean;
    safeNextAction: string;
  };
  assert.equal(status.version, await packageVersion());
  assert.equal(status.runId, runId);
  assert.equal(status.status, "running");
  assert.equal(status.phase, "runtime_ownership_unknown");
  assert.equal(status.lastEventSequence, 12);
  assert.equal(status.runtime.ownership, "missing");
  assert.deepEqual(status.controller, {
    pendingTurns: 0,
    acceptedCommands: 1,
    responseAccepted: true,
    lastAcceptedAction: "dispatch",
    lastAcceptedRequestId: "msg_cli_status",
    lastAcceptedJobKeys: ["audit_1", "audit_2", "audit_3", "audit_4"],
  });
  assert.equal(status.jobs.total, 4);
  assert.equal(status.jobs.counts.timed_out, 3);
  assert.equal(status.jobs.counts.running, 0);
  assert.equal(status.jobs.counts.orphaned, 1);
  assert.equal(status.continueAllowed, false);
  assert.equal(status.safeNextAction, "inspect_runtime");

  const humanResult = invoke(["run", "status", runId], context.environment);
  assert.equal(humanResult.status, 0, humanResult.stderr);
  assert.match(humanResult.stdout, /phase\s+runtime_ownership_unknown/);
  assert.match(humanResult.stdout, /runtime\s+missing/);
  assert.match(humanResult.stdout, /controller\s+response_accepted/);
  assert.match(humanResult.stdout, /jobs\s+total=4\s+.*running=0\s+.*timed_out=3\s+.*orphaned=1/);
  assert.match(humanResult.stdout, /next\s+inspect_runtime/);
});

test("run reconcile records operator-confirmed manual submission without resending", async () => {
  const context = await fixture();
  const runId = "run_cli_manual_reconcile";
  const requestId = "msg_cli_manual_reconcile";
  const conversationUrl = "https://chatgpt.com/c/cli-manual-reconcile";
  const store = await RunStore.create({
    home: context.home,
    runId,
    initialState: initialRunState(runId, "", "process", 12, true),
    reducer: reduceRunState,
  });
  await store.append("run_created", { request: "Recover manual attachment" });
  await store.append("controller_turn_requested", {
    round: 2,
    request_id: requestId,
    prompt: "large attachment prompt",
    prompt_hash: "large-prompt-hash",
  });
  await store.append("controller_conversation_bound", {
    request_id: requestId,
    conversation_url: conversationUrl,
  });
  await store.append("controller_turn_abandoned", {
    round: 2,
    request_id: requestId,
    reason: "legacy_abandon",
  });
  await store.append("run_failed", { code: "LEGACY_RECONCILIATION_FAILURE" });
  await store.snapshot();

  const result = invoke(
    [
      "run",
      "reconcile",
      runId,
      "--request-id",
      requestId,
      "--manual-send-confirmed",
      "--json",
    ],
    context.environment,
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    runId,
    requestId,
    conversationUrl,
    outcome: "confirmed",
  });
  const events = await readEvents(runPaths(context.home, runId).events);
  assert.equal(
    events.filter((event) => event.type === "controller_turn_manual_submission_confirmed")
      .length,
    1,
  );

  const repeated = invoke(
    [
      "run",
      "reconcile",
      runId,
      "--request-id",
      requestId,
      "--manual-send-confirmed",
      "--json",
    ],
    context.environment,
  );
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).outcome, "already_confirmed");
  assert.equal(
    (await readEvents(runPaths(context.home, runId).events)).filter(
      (event) => event.type === "controller_turn_manual_submission_confirmed",
    ).length,
    1,
  );
});

test("run reconcile accepts the first conversation URL created by a manual send", async () => {
  const context = await fixture();
  const runId = "run_cli_manual_first_url";
  const requestId = "msg_cli_manual_first_url";
  const conversationUrl = "https://chatgpt.com/c/cli-manual-first-url";
  const store = await RunStore.create({
    home: context.home,
    runId,
    initialState: initialRunState(runId, ""),
    reducer: reduceRunState,
  });
  await store.append("run_created", { request: "Bind URL after one manual send" });
  await store.append("controller_turn_requested", {
    round: 1,
    request_id: requestId,
    prompt: "manual prompt",
    prompt_hash: "cli-manual-first-url-hash",
  });
  await store.append("run_failed", {
    code: "CONTROLLER_PROMPT_NOT_READY",
    request_id: requestId,
    stage: "pre_submit",
    submission_state: "definitely_not_sent",
  });
  await store.snapshot();

  const result = invoke(
    [
      "run",
      "reconcile",
      runId,
      "--request-id",
      requestId,
      "--manual-send-confirmed",
      "--conversation-url",
      conversationUrl,
      "--json",
    ],
    context.environment,
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    runId,
    requestId,
    conversationUrl,
    outcome: "confirmed",
  });
  const eventTypes = (await readEvents(runPaths(context.home, runId).events)).map(
    (event) => event.type,
  );
  assert.ok(
    eventTypes.indexOf("controller_conversation_bound") <
      eventTypes.indexOf("controller_turn_manual_submission_confirmed"),
  );
});

test("run reconcile-runtime settles a dead ownerless advise job", async () => {
  const context = await fixture();
  const runId = "run_cli_runtime_reconcile";
  const id = await seedOneRunningJob(context.home, runId);
  await new JobStatusStore(context.home).write({
    jobId: id,
    runId,
    jobKey: "legacy_job",
    lane: "default",
    mode: "advise",
    pid: 2_147_483_647,
    execution: "foreground",
    status: "running",
    startedAt: "2026-07-15T00:00:00.000Z",
  });

  const result = invoke(["run", "reconcile-runtime", runId, "--json"], context.environment);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    runId,
    outcome: "reconciled",
    affectedJobs: 1,
    survivingJobs: [],
  });
  const status = JSON.parse(
    invoke(["run", "status", runId, "--json"], context.environment).stdout,
  ) as { status: string; jobs: { counts: Record<string, number> } };
  assert.equal(status.status, "failed");
  assert.equal(status.jobs.counts.failed, 1);
  assert.equal(status.jobs.counts.orphaned, 0);
});

test("run takeover retires one exact stale owner and reports the next action", async () => {
  const context = await fixture();
  const runId = "run_cli_stale_takeover";
  const store = await RunStore.create({
    home: context.home,
    runId,
    initialState: initialRunState(runId, "", "caller"),
    reducer: reduceRunState,
  });
  await store.append("run_created", { request: "Resume stale CLI run", executor: "caller" });
  const heartbeatAt = "2000-01-01T00:00:00.000Z";
  await writeFile(
    runPaths(context.home, runId).runtimeLease,
    `${JSON.stringify({
      protocol: "cueline/runtime-lease/0.1",
      run_id: runId,
      owner_id: "cli-stale-owner",
      pid: String(process.pid),
      state: "active",
      claimed_at: heartbeatAt,
      heartbeat_at: heartbeatAt,
    })}\n`,
    "utf8",
  );

  const result = invoke(["run", "takeover", runId, "--json"], context.environment);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    runId,
    outcome: "taken_over",
    next: "continue",
    previousOwnerId: "cli-stale-owner",
  });
  const events = await readEvents(runPaths(context.home, runId).events);
  assert.deepEqual(
    events
      .filter((event) => event.type.startsWith("runtime_stale_owner_takeover_"))
      .map((event) => event.type),
    [
      "runtime_stale_owner_takeover_requested",
      "runtime_stale_owner_takeover_confirmed",
    ],
  );
});

test("run takeover directs an interrupted process run through runtime reconciliation", async () => {
  const context = await fixture();
  const runId = "run_cli_process_takeover";
  const store = await RunStore.create({
    home: context.home,
    runId,
    initialState: initialRunState(runId, ""),
    reducer: reduceRunState,
  });
  await store.append("run_created", {
    request: "Reconcile a lost process owner",
    executor: "process",
    allow_process_execution: true,
  });
  await store.append("controller_turn_requested", {
    round: 1,
    request_id: "msg_cli_process_takeover",
    prompt: "controller prompt",
    prompt_hash: "cli-process-takeover-hash",
  });
  const heartbeatAt = "2000-01-01T00:00:00.000Z";
  await writeFile(
    runPaths(context.home, runId).runtimeLease,
    `${JSON.stringify({
      protocol: "cueline/runtime-lease/0.1",
      run_id: runId,
      owner_id: "cli-process-stale-owner",
      pid: String(process.pid),
      state: "active",
      claimed_at: heartbeatAt,
      heartbeat_at: heartbeatAt,
    })}\n`,
    "utf8",
  );

  const result = invoke(["run", "takeover", runId, "--json"], context.environment);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    runId,
    outcome: "taken_over",
    next: "reconcile_runtime",
    previousOwnerId: "cli-process-stale-owner",
  });
});

test("run takeover refuses a fresh active owner", async () => {
  const context = await fixture();
  const runId = "run_cli_active_takeover_refused";
  const store = await RunStore.create({
    home: context.home,
    runId,
    initialState: initialRunState(runId, "", "caller"),
    reducer: reduceRunState,
  });
  await store.append("run_created", { request: "Keep active CLI owner", executor: "caller" });
  const heartbeatAt = new Date().toISOString();
  await writeFile(
    runPaths(context.home, runId).runtimeLease,
    `${JSON.stringify({
      protocol: "cueline/runtime-lease/0.1",
      run_id: runId,
      owner_id: "cli-active-owner",
      pid: String(process.pid),
      state: "active",
      claimed_at: heartbeatAt,
      heartbeat_at: heartbeatAt,
    })}\n`,
    "utf8",
  );

  const result = invoke(["run", "takeover", runId, "--json"], context.environment);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /RUNTIME_TAKEOVER_ACTIVE_REFUSED/);
});

test("run cancel safely closes an ownerless legacy run and marks running work ambiguous", async () => {
  const context = await fixture();
  const runId = await seedActiveRun(context.home);
  const cancelResult = invoke(["run", "cancel", runId, "--json"], context.environment);

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  const cancellation = JSON.parse(cancelResult.stdout) as {
    runId: string;
    outcome: string;
    affectedJobs: number;
  };
  assert.deepEqual(cancellation, {
    runId,
    outcome: "cancelled",
    affectedJobs: 1,
  });

  const statusResult = invoke(["run", "status", runId, "--json"], context.environment);
  assert.equal(statusResult.status, 0, statusResult.stderr);
  const status = JSON.parse(statusResult.stdout) as {
    status: string;
    phase: string;
    jobs: { counts: Record<string, number> };
    safeNextAction: string;
  };
  assert.equal(status.status, "cancelled");
  assert.equal(status.phase, "cancelled");
  assert.equal(status.jobs.counts.running, 0);
  assert.equal(status.jobs.counts.ambiguous, 1);
  assert.equal(status.safeNextAction, "return_result");
});

test("job cancel marks an ownerless running job ambiguous without claiming it was killed", async () => {
  const context = await fixture();
  const runId = "run_cli_job_cancel";
  const id = await seedOneRunningJob(context.home, runId);
  const result = invoke(["job", "cancel", runId, id, "--json"], context.environment);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    runId,
    jobId: id,
    outcome: "ambiguous",
  });
  const statusResult = invoke(["run", "status", runId, "--json"], context.environment);
  const status = JSON.parse(statusResult.stdout) as {
    status: string;
    jobs: { counts: Record<string, number> };
  };
  assert.equal(status.status, "failed");
  assert.equal(status.jobs.counts.ambiguous, 1);
});

test("jobs reports run, job key, lane, mode, and PID metadata", async () => {
  const context = await fixture();
  const store = new JobStatusStore(context.home);
  await store.write({
    jobId: "job_observable",
    runId: "run_observable",
    jobKey: "audit",
    lane: "default",
    mode: "advise",
    pid: 43210,
    execution: "background",
    status: "running",
    startedAt: "2026-07-15T00:00:00.000Z",
  });

  const result = invoke(["jobs", "--json"], context.environment);
  assert.equal(result.status, 0, result.stderr);
  const jobs = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
  assert.deepEqual(jobs, [
    {
      jobId: "job_observable",
      runId: "run_observable",
      jobKey: "audit",
      lane: "default",
      mode: "advise",
      pid: 43210,
      execution: "background",
      status: "running",
      observedStatus: "orphaned",
      startedAt: "2026-07-15T00:00:00.000Z",
    },
  ]);

  const human = invoke(["jobs"], context.environment);
  assert.equal(human.status, 0, human.stderr);
  assert.match(
    human.stdout,
    /job_observable\s+run_observable\s+audit\s+default\s+advise\s+43210\s+background\s+orphaned/,
  );
});

test("jobs reconstructs legacy run metadata from the authoritative event log", async () => {
  const context = await fixture();
  const runId = "run_legacy_observable";
  const id = await seedOneRunningJob(context.home, runId);
  await new JobStatusStore(context.home).write({
    jobId: id,
    execution: "foreground",
    status: "running",
    startedAt: "2026-07-15T00:00:00.000Z",
  });

  const result = invoke(["jobs", "--json"], context.environment);
  assert.equal(result.status, 0, result.stderr);
  const jobs = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
  assert.deepEqual(jobs, [
    {
      runId,
      jobKey: "legacy_job",
      lane: "default",
      mode: "advise",
      task: "Inspect",
      jobId: id,
      execution: "foreground",
      status: "running",
      startedAt: "2026-07-15T00:00:00.000Z",
      observedStatus: "orphaned",
    },
  ]);
});

test("jobs exposes caller-pending work even before any result status file exists", async () => {
  const context = await fixture();
  const runId = "run_caller_pending_observable";
  const store = await RunStore.create({
    home: context.home,
    runId,
    initialState: initialRunState(runId, "", "caller"),
    reducer: reduceRunState,
  });
  await store.append("run_created", { request: "Caller must see the task", executor: "caller" });
  const spec = {
    job_key: "caller_audit",
    lane: "default",
    mode: "advise" as const,
    task: "Inspect the exact caller task",
    required: true,
  };
  const id = jobId(runId, spec.job_key, spec);
  await store.append("job_registered", {
    job: {
      jobId: id,
      jobKey: spec.job_key,
      required: true,
      spec,
      status: "pending",
      output: null,
      error: null,
    },
  });
  await store.snapshot();

  const result = invoke(["jobs", "--json"], context.environment);
  assert.equal(result.status, 0, result.stderr);
  const jobs = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0], {
    jobId: id,
    runId,
    jobKey: "caller_audit",
    lane: "default",
    mode: "advise",
    task: "Inspect the exact caller task",
    execution: "foreground",
    status: "pending",
    startedAt: jobs[0]?.startedAt,
    observedStatus: "pending",
  });
});

test("jobs keeps authoritative terminal run evidence when a retired owner writes late status", async () => {
  const context = await fixture();
  const runId = "run_late_job_status_conflict";
  const id = "job_late_job_status_conflict";
  const store = await RunStore.create({
    home: context.home,
    runId,
    initialState: initialRunState(runId, "", "process"),
    reducer: reduceRunState,
  });
  await store.append("run_created", { request: "Keep authoritative failure", executor: "process" });
  await store.append("job_registered", {
    job: {
      jobId: id,
      jobKey: "late_writer",
      required: true,
      spec: {
        job_key: "late_writer",
        lane: "default",
        mode: "advise",
        task: "Do not trust a retired owner",
      },
      status: "running",
      output: null,
      error: null,
    },
  });
  await store.append("job_status", {
    job_id: id,
    status: "failed",
    error: "OWNER_LOST",
  });
  await store.snapshot();
  await new JobStatusStore(context.home).write({
    jobId: id,
    runId,
    jobKey: "late_writer",
    lane: "default",
    mode: "advise",
    execution: "foreground",
    status: "succeeded",
    startedAt: "2026-07-15T00:00:00.000Z",
    finishedAt: "2026-07-15T00:01:00.000Z",
    result: {
      status: "succeeded",
      stdout: "LATE_OLD_OWNER",
      stderr: "",
      output: "LATE_OLD_OWNER",
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      ambiguousSideEffects: false,
      emptyOutput: false,
      retryable: false,
      startedAt: "2026-07-15T00:00:00.000Z",
      finishedAt: "2026-07-15T00:01:00.000Z",
    },
  });

  const result = invoke(["jobs", "--json"], context.environment);
  assert.equal(result.status, 0, result.stderr);
  const jobs = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.status, "failed");
  assert.equal(jobs[0]?.observedStatus, "conflict");
  assert.equal(jobs[0]?.persistedStatus, "succeeded");
  assert.equal(jobs[0]?.result, undefined);
  assert.doesNotMatch(result.stdout, /LATE_OLD_OWNER/);
});

test("install and uninstall manage the Codex skill link idempotently", async () => {
  const context = await fixture();
  const target = path.join(context.home, "codex", "skills", "cueline");
  const environment = { ...context.environment, CODEX_HOME: path.join(context.home, "codex") };

  for (const attempt of [1, 2]) {
    const installed = invoke(["install"], environment);
    assert.equal(installed.status, 0, `attempt ${attempt}: ${installed.stderr}`);
    assert.equal(await readlink(target), path.join(packageRoot, "skills", "cueline"));
  }

  const removed = invoke(["uninstall"], environment);
  assert.equal(removed.status, 0, removed.stderr);
  await assert.rejects(readlink(target), { code: "ENOENT" });
});

test("install refuses a foreign skill path and uninstall preserves it", async () => {
  const context = await fixture();
  const codexHome = path.join(context.home, "codex");
  const target = path.join(codexHome, "skills", "cueline");
  const environment = { ...context.environment, CODEX_HOME: codexHome };
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "foreign\n", "utf8");

  const installed = invoke(["install"], environment);
  assert.equal(installed.status, 1);
  assert.match(installed.stderr, /refusing to replace foreign path/);

  const removed = invoke(["uninstall"], environment);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(await readFile(target, "utf8"), "foreign\n");
});

test("help lists every command, the environment, and the exit codes", async () => {
  const context = await fixture();

  for (const args of [[], ["help"], ["--help"], ["-h"]]) {
    const result = invoke(args, context.environment);

    assert.equal(result.status, 0, result.stderr);
    for (const command of [
      "install",
      "uninstall",
      "doctor",
      "routing",
      "jobs",
      "run status",
      "run reconcile",
      "run takeover",
      "run reconcile-runtime",
      "run cancel",
      "run stop",
      "job cancel",
      "api path",
      "config path",
      "version",
    ]) {
      assert.match(result.stdout, new RegExp(`^\\s+${command}\\s{2,}\\S`, "m"));
    }
    assert.match(result.stdout, /CUELINE_HOME/);
    assert.match(result.stdout, /CUELINE_CONFIG/);
    assert.match(result.stdout, /exit codes:/);
    for (const syntax of [
      "doctor [--json]",
      "jobs [--json]",
      "run status <run-id> [--json]",
      "run reconcile <run-id> --request-id <request-id> --manual-send-confirmed [--conversation-url <url>] [--json]",
      "run takeover <run-id> [--json]",
      "run reconcile-runtime <run-id> [--json]",
      "run cancel <run-id> [--json]",
      "run stop <run-id> [--json]",
      "job cancel <run-id> <job-id> [--json]",
    ]) {
      assert.ok(result.stdout.includes(syntax), `missing CLI syntax: ${syntax}`);
    }
    assert.match(result.stdout, /read-only/i);
    assert.match(result.stdout, /append-only|durable state/i);
    assert.doesNotMatch(result.stdout, /commands only diagnose/i);
  }
});

test("nested command help never treats --help as a run or job id", async () => {
  const context = await fixture();
  for (const args of [
    ["doctor", "--help"],
    ["run", "--help"],
    ["run", "status", "--help"],
    ["run", "reconcile", "--help"],
    ["run", "takeover", "--help"],
    ["run", "reconcile-runtime", "--help"],
    ["run", "cancel", "--help"],
    ["run", "stop", "--help"],
    ["job", "--help"],
    ["job", "cancel", "--help"],
    ["api", "--help"],
    ["api", "path", "--help"],
    ["config", "--help"],
    ["config", "path", "--help"],
  ]) {
    const result = invoke(args, context.environment);
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stdout, /usage: cueline/);
    assert.equal(result.stderr.trim(), "");
  }
});

test("version prints the package version alone", async () => {
  const context = await fixture();
  const expectedVersion = await packageVersion();

  for (const args of [["version"], ["--version"], ["-v"]]) {
    const result = invoke(args, context.environment);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expectedVersion);
  }
});

test("an unrecognized command explains itself and exits with a usage code", async () => {
  const context = await fixture();
  const result = invoke(["lint"], context.environment);

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /unrecognized command: lint/);
  assert.match(result.stderr, /usage: cueline/);
  assert.match(result.stderr, /cueline help/);
});

test("an incomplete state-changing command exits with the documented usage code", async () => {
  const context = await fixture();
  const result = invoke(
    ["run", "reconcile", "run_missing_confirmation", "--request-id", "msg_pending"],
    context.environment,
  );

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /CLI_ARGUMENTS_INVALID/);
  assert.match(result.stderr, /--manual-send-confirmed/);
});
