import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readlink, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { commandHash, jobId } from "../../src/core/ids.js";
import { initialRunState, reduceRunState } from "../../src/core/state-machine.js";
import { JobStatusStore, type JobStatus } from "../../src/jobs/status.js";
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

test("protocol lint catches legacy Pro fields without touching run state", async () => {
  const context = await fixture();
  const response = path.join(path.dirname(context.config), "controller-response.txt");
  await writeFile(
    response,
    `<CueLineControl>${JSON.stringify({
      protocol: "cueline/0.1",
      run_id: "run_cli_lint",
      round: 1,
      request_id: "msg_cli_lint",
      action: "dispatch",
      jobs: [
        {
          job_key: "audit",
          lane: "node",
          mode: "advise",
          prompt: "Inspect",
          runner_id: "node",
        },
      ],
    })}</CueLineControl>`,
    "utf8",
  );

  const result = invoke(
    [
      "protocol",
      "lint",
      response,
      "--run-id",
      "run_cli_lint",
      "--round",
      "1",
      "--request-id",
      "msg_cli_lint",
      "--json",
    ],
    context.environment,
  );

  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout) as {
    valid: boolean;
    issues: Array<{ code: string }>;
  };
  assert.equal(report.valid, false);
  assert.ok(report.issues.some((issue) => issue.code === "LEGACY_PROMPT_FIELD"));
  assert.ok(report.issues.some((issue) => issue.code === "LEGACY_RUNNER_ID_FIELD"));
  assert.ok(report.issues.some((issue) => issue.code === "RUNNER_USED_AS_LANE"));
});

test("routing exposes a stable JSON report without runner argv", async () => {
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
              id: "node",
              argv: [process.execPath, "--PRIVATE_ARG_SENTINEL"],
              task_input: "stdin",
            },
          ],
        },
        missing: {
          enabled: true,
          candidates: [
            {
              id: "missing-runner",
              argv: ["definitely-missing-cueline-runner"],
              task_input: "stdin",
            },
          ],
        },
        disabled: {
          enabled: false,
          candidates: [
            {
              id: "disabled-runner",
              argv: [process.execPath],
              task_input: "stdin",
            },
          ],
        },
      },
    })}\n`,
    "utf8",
  );

  const result = invoke(["routing", "--json"], context.environment);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    version: await packageVersion(),
    config: {
      path: context.config,
      valid: true,
    },
    availableLanes: 1,
    lanes: [
      {
        name: "default",
        enabled: true,
        status: "available",
        selectedRunnerId: "node",
      },
      {
        name: "missing",
        enabled: true,
        status: "unavailable",
        selectedRunnerId: null,
        errorCode: "ROUTE_NO_CANDIDATE",
      },
      {
        name: "disabled",
        enabled: false,
        status: "disabled",
        selectedRunnerId: null,
      },
    ],
    findings: [],
  });
  assert.doesNotMatch(result.stdout, /PRIVATE_ARG_SENTINEL|definitely-missing/);
});

test("routing JSON remains parseable and redacted for an invalid config", async () => {
  const context = await fixture();
  await writeFile(context.config, "{PRIVATE_ROUTING_SENTINEL", "utf8");

  const result = invoke(["routing", "--json"], context.environment);

  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    version: await packageVersion(),
    config: {
      path: context.config,
      valid: false,
      errorCode: "ROUTING_CONFIG_INVALID",
    },
    availableLanes: 0,
    lanes: [],
    findings: [
      {
        code: "ROUTING_CONFIG_INVALID",
        message: "Routing configuration could not be loaded.",
      },
    ],
  });
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /PRIVATE_ROUTING_SENTINEL/);
});

test("routing JSON exits unavailable when no enabled lane resolves", async () => {
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
              id: "missing-only",
              argv: ["definitely-missing-cueline-runner"],
              task_input: "stdin",
            },
          ],
        },
      },
    })}\n`,
    "utf8",
  );

  const result = invoke(["routing", "--json"], context.environment);

  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout) as {
    availableLanes: number;
    lanes: Array<{ status: string; errorCode?: string }>;
  };
  assert.equal(report.availableLanes, 0);
  assert.deepEqual(report.lanes, [
    {
      name: "default",
      enabled: true,
      status: "unavailable",
      selectedRunnerId: null,
      errorCode: "ROUTE_NO_CANDIDATE",
    },
  ]);
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

test("runs lists safe run summaries in human and JSON forms", async () => {
  const context = await fixture();
  const runId = await seedActiveRun(context.home);

  const jsonResult = invoke(["runs", "--json"], context.environment);
  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  const runs = JSON.parse(jsonResult.stdout) as Array<Record<string, unknown>>;
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.runId, runId);
  assert.equal(runs[0]?.readable, true);
  assert.equal(runs[0]?.phase, "runtime_ownership_unknown");
  assert.equal("task" in (runs[0] ?? {}), false);

  const humanResult = invoke(["runs"], context.environment);
  assert.equal(humanResult.status, 0, humanResult.stderr);
  assert.match(
    humanResult.stdout,
    new RegExp(`${runId}\\s+running\\s+process\\s+runtime_ownership_unknown\\s+inspect_runtime`),
  );
  assert.doesNotMatch(humanResult.stdout, /Inspect a large project|Audit 1/);
});

test("runs reports degraded while preserving readable entries beside a corrupt run", async () => {
  const context = await fixture();
  const runId = await seedActiveRun(context.home);
  await mkdir(path.join(context.home, "runs", "run_corrupt_cli"), { recursive: true });

  const result = invoke(["runs", "--json"], context.environment);

  assert.equal(result.status, 1, result.stderr);
  const runs = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
  assert.equal(runs.some((run) => run.runId === runId && run.readable === true), true);
  assert.deepEqual(
    runs.find((run) => run.runId === "run_corrupt_cli"),
    { runId: "run_corrupt_cli", readable: false, errorCode: "RUN_NOT_FOUND" },
  );
});

test("jobs rejects structurally invalid persisted job evidence", async () => {
  const context = await fixture();
  const jobsDirectory = path.join(context.home, "jobs");
  await mkdir(jobsDirectory, { recursive: true });
  await writeFile(path.join(jobsDirectory, "malformed.json"), "{}\n", "utf8");

  const result = invoke(["jobs", "--json"], context.environment);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /JOB_STATUS_INVALID/);
  assert.equal(result.stdout, "");
});

test("run status catches invalid retirement evidence without a stack trace", async () => {
  const context = await fixture();
  const runId = await seedActiveRun(context.home);
  const ownerId = "owner-invalid-cli-retirement";
  const ownerHash = createHash("sha256").update(ownerId).digest("hex").slice(0, 24);
  const directory = `${runPaths(context.home, runId).runtimeLease}.retired-owners`;
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, `${ownerHash}-00000000-0000-4000-8000-000000000000.json`),
    `${JSON.stringify({
      protocol: "cueline/runtime-owner-retirement/0.1",
      run_id: runId,
      owner_id: ownerId,
      events_after_sequence: 0,
      retired_at: "2026-07-16T00:00:00.000Z",
      extra: true,
    })}\n`,
    "utf8",
  );

  const result = invoke(["run", "status", runId, "--json"], context.environment);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /RUNTIME_OWNER_RETIREMENT_INVALID/);
  assert.doesNotMatch(result.stderr, /at parseRetirement|file:\/\//);
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
      items: Array<Record<string, unknown>>;
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
  assert.equal(status.jobs.items.some((job) => "task" in job), false);
  assert.doesNotMatch(jsonResult.stdout, /Audit [1-4]/);
  assert.equal(status.continueAllowed, false);
  assert.equal(status.safeNextAction, "inspect_runtime");

  const humanResult = invoke(["run", "status", runId], context.environment);
  assert.equal(humanResult.status, 0, humanResult.stderr);
  assert.match(humanResult.stdout, /phase\s+runtime_ownership_unknown/);
  assert.match(humanResult.stdout, /runtime\s+missing/);
  assert.match(humanResult.stdout, /controller\s+response_accepted/);
  assert.match(humanResult.stdout, /jobs\s+total=4\s+.*running=0\s+.*timed_out=3\s+.*orphaned=1/);
  assert.doesNotMatch(humanResult.stdout, /task=/);
  assert.doesNotMatch(humanResult.stdout, /Audit [1-4]/);
  assert.match(humanResult.stdout, /next\s+inspect_runtime/);
});

test("run doctor explains the blocker without mutating the run", async () => {
  const context = await fixture();
  const runId = await seedActiveRun(context.home);
  const before = await readEvents(runPaths(context.home, runId).events);

  const result = invoke(["run", "doctor", runId, "--json"], context.environment);

  assert.equal(result.status, 1, result.stderr);
  const diagnosis = JSON.parse(result.stdout) as {
    outcome: string;
    nextAction: string;
    findings: Array<{ code: string }>;
  };
  assert.equal(diagnosis.outcome, "blocked");
  assert.equal(diagnosis.nextAction, "inspect_runtime");
  assert.equal(diagnosis.findings[0]?.code, "RUNTIME_OWNERSHIP_UNKNOWN");
  const after = await readEvents(runPaths(context.home, runId).events);
  assert.deepEqual(after, before);
});

test("run watch returns immediately on a newer event and never mutates the run", async () => {
  const context = await fixture();
  const runId = await seedActiveRun(context.home);
  const before = await readEvents(runPaths(context.home, runId).events);

  const result = invoke(
    ["run", "watch", runId, "--after", "11", "--timeout-ms", "0", "--json"],
    context.environment,
  );

  assert.equal(result.status, 0, result.stderr);
  const observation = JSON.parse(result.stdout) as {
    version: string;
    outcome: string;
    previousSequence: number;
    currentSequence: number;
    elapsedMs: number;
    status: { runId: string };
  };
  assert.equal(observation.version, await packageVersion());
  assert.equal(observation.outcome, "changed");
  assert.equal(observation.previousSequence, 11);
  assert.equal(observation.currentSequence, 12);
  assert.equal(observation.status.runId, runId);
  const after = await readEvents(runPaths(context.home, runId).events);
  assert.deepEqual(after, before);
});

test("run timeline paginates the authoritative log without exposing payloads or writing", async () => {
  const context = await fixture();
  const runId = await seedActiveRun(context.home);
  const before = await readEvents(runPaths(context.home, runId).events);

  const result = invoke(
    ["run", "timeline", runId, "--after", "9", "--limit", "2", "--json"],
    context.environment,
  );

  assert.equal(result.status, 0, result.stderr);
  const timeline = JSON.parse(result.stdout) as {
    runId: string;
    entries: Array<{ sequence: number; payload?: unknown }>;
    hasMore: boolean;
    nextAfterSequence: number;
  };
  assert.equal(timeline.runId, runId);
  assert.deepEqual(timeline.entries.map((entry) => entry.sequence), [10, 11]);
  assert.ok(timeline.entries.every((entry) => !("payload" in entry)));
  assert.equal(timeline.hasMore, true);
  assert.equal(timeline.nextAfterSequence, 11);
  const after = await readEvents(runPaths(context.home, runId).events);
  assert.deepEqual(after, before);
});

test("run status-at reconstructs a sanitized historical state without writing", async () => {
  const context = await fixture();
  const runId = await seedActiveRun(context.home);
  const before = await readEvents(runPaths(context.home, runId).events);

  const result = invoke(
    ["run", "status-at", runId, "--sequence", "4", "--json"],
    context.environment,
  );

  assert.equal(result.status, 0, result.stderr);
  const historical = JSON.parse(result.stdout) as {
    schema: string;
    runId: string;
    requestedSequence: number;
    latestSequence: number;
    authoritativeEventsApplied: number;
    state: {
      status: string;
      round: number;
      pendingControllerTurns: number;
      acceptedCommands: number;
      jobs: { total: number; counts: Record<string, number> };
    };
  };
  assert.equal(historical.schema, "cueline-status-at/0.1");
  assert.equal(historical.runId, runId);
  assert.equal(historical.requestedSequence, 4);
  assert.equal(historical.latestSequence, 12);
  assert.equal(historical.authoritativeEventsApplied, 4);
  assert.equal(historical.state.status, "running");
  assert.equal(historical.state.round, 1);
  assert.equal(historical.state.pendingControllerTurns, 0);
  assert.equal(historical.state.acceptedCommands, 1);
  assert.deepEqual(historical.state.jobs, { total: 0, counts: {} });
  assert.ok(!result.stdout.includes("Persisted controller prompt"));
  assert.ok(!result.stdout.includes("Inspect a large project"));
  const after = await readEvents(runPaths(context.home, runId).events);
  assert.deepEqual(after, before);
});

test("run status-at rejects a future sequence without guessing or writing", async () => {
  const context = await fixture();
  const runId = await seedActiveRun(context.home);
  const before = await readEvents(runPaths(context.home, runId).events);

  const result = invoke(
    ["run", "status-at", runId, "--sequence", "13", "--json"],
    context.environment,
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /RUN_STATUS_AT_SEQUENCE_AHEAD/);
  const after = await readEvents(runPaths(context.home, runId).events);
  assert.deepEqual(after, before);
});

test("run status-at rejects invalid or duplicate sequence flags as usage errors", async () => {
  const context = await fixture();
  const runId = await seedActiveRun(context.home);
  for (const args of [
    ["run", "status-at", runId, "--sequence", "0"],
    ["run", "status-at", runId, "--sequence", "4.5"],
    ["run", "status-at", runId, "--sequence", "4", "--sequence", "5"],
  ]) {
    const result = invoke(args, context.environment);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /CLI_ARGUMENTS_INVALID/);
  }
});

test("run handoff emits exact paths without changing durable state", async () => {
  const context = await fixture();
  const runId = await seedActiveRun(context.home);
  const before = await readEvents(runPaths(context.home, runId).events);

  const result = invoke(["run", "handoff", runId, "--json"], context.environment);

  assert.equal(result.status, 0, result.stderr);
  const packet = JSON.parse(result.stdout) as {
    schema: string;
    run: { runId: string; eventSequence: number };
    paths: { runDir: string; events: string };
    content?: unknown;
  };
  assert.equal(packet.schema, "cueline-handoff/0.1");
  assert.equal(packet.run.runId, runId);
  assert.equal(packet.run.eventSequence, 12);
  assert.equal(packet.paths.runDir, runPaths(context.home, runId).runDir);
  assert.equal(packet.paths.events, runPaths(context.home, runId).events);
  assert.equal(packet.content, undefined);
  const after = await readEvents(runPaths(context.home, runId).events);
  assert.deepEqual(after, before);
});

test("run watch rejects an out-of-contract timeout as a CLI usage error", async () => {
  const context = await fixture();
  const runId = await seedActiveRun(context.home);

  const result = invoke(
    ["run", "watch", runId, "--after", "12", "--timeout-ms", "30001"],
    context.environment,
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /CLI_ARGUMENTS_INVALID/);
});

test("run handoff rejects a content limit when content is not enabled", async () => {
  const context = await fixture();
  const runId = await seedActiveRun(context.home);

  const result = invoke(
    ["run", "handoff", runId, "--max-content-chars", "100"],
    context.environment,
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /CLI_ARGUMENTS_INVALID/);
});

test("run verify reports durable evidence health in human and JSON forms", async () => {
  const context = await fixture();
  const runId = await seedActiveRun(context.home);

  const jsonResult = invoke(["run", "verify", runId, "--json"], context.environment);
  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  const report = JSON.parse(jsonResult.stdout) as Record<string, unknown>;
  assert.equal(report.runId, runId);
  assert.equal(report.outcome, "verified");
  assert.equal("request" in report, false);

  const humanResult = invoke(["run", "verify", runId], context.environment);
  assert.equal(humanResult.status, 0, humanResult.stderr);
  assert.match(humanResult.stdout, new RegExp(`run\\s+${runId}`));
  assert.match(humanResult.stdout, /outcome\s+verified/);
  assert.doesNotMatch(humanResult.stdout, /Inspect a large project|Audit 1/);
});

test("run verify exits degraded with static findings for corrupt optional evidence", async () => {
  const context = await fixture();
  const runId = await seedActiveRun(context.home);
  await writeFile(runPaths(context.home, runId).snapshot, "{PRIVATE_BAD_SNAPSHOT", "utf8");

  const result = invoke(["run", "verify", runId, "--json"], context.environment);

  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout) as {
    outcome: string;
    findings: Array<{ code: string }>;
  };
  assert.equal(report.outcome, "degraded");
  assert.deepEqual(report.findings.map((finding) => finding.code), [
    "SNAPSHOT_INVALID_JSON",
  ]);
  assert.doesNotMatch(result.stdout, /PRIVATE_BAD_SNAPSHOT/);
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

test("run reconcile records operator-confirmed not-sent once and abandons the exact turn", async () => {
  const context = await fixture();
  const runId = "run_cli_not_sent_reconcile";
  const requestId = "msg_cli_not_sent_reconcile";
  const conversationUrl = "https://chatgpt.com/c/cli-not-sent-reconcile";
  const prompt = "synthetic round-two evidence prompt";
  const promptHash = commandHash(prompt);
  const store = await RunStore.create({
    home: context.home,
    runId,
    initialState: initialRunState(runId, "", "caller"),
    reducer: reduceRunState,
  });
  await store.append("run_created", { request: "Recover an ambiguous controller click" });
  await store.append("controller_conversation_bound", {
    request_id: "msg_prior",
    conversation_url: conversationUrl,
  });
  await store.append("controller_turn_requested", {
    round: 2,
    request_id: requestId,
    prompt,
    prompt_hash: promptHash,
    submission_checkpoint_contract: "write_ahead_v1",
  });
  await store.append("controller_turn_submission_started", {
    round: 2,
    request_id: requestId,
    submission_state: "submitting",
    conversation_url: conversationUrl,
    selected_model_label: "Pro",
    composer_prompt_state: "attachment_ready",
    baseline_assistant_message_count: 2,
  });
  await store.append("run_failed", {
    code: "CONTROLLER_SUBMISSION_AMBIGUOUS",
    request_id: requestId,
    stage: "submitting",
    submission_state: "possibly_sent",
    conversation_url: conversationUrl,
  });
  await store.snapshot();

  const beforeStatus = invoke(["run", "status", runId, "--json"], context.environment);
  assert.equal(beforeStatus.status, 0, beforeStatus.stderr);
  assert.deepEqual(JSON.parse(beforeStatus.stdout).controller.reconciliation, {
    requiredReason: "CONTROLLER_SUBMISSION_AMBIGUOUS",
    operatorConfirmation: null,
    abandonedRequestId: null,
    retryRequestId: null,
    promptHash: null,
    resendBlockedReason: null,
  });

  const result = invoke(
    [
      "run",
      "reconcile",
      runId,
      "--request-id",
      requestId,
      "--not-sent-confirmed",
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
    promptHash,
    outcome: "confirmed",
  });
  const firstEvents = await readEvents(runPaths(context.home, runId).events);
  assert.equal(
    firstEvents.filter((event) => event.type === "controller_turn_not_sent_confirmed").length,
    1,
  );
  assert.equal(
    firstEvents.filter(
      (event) =>
        event.type === "controller_turn_abandoned" &&
        (event.payload as Record<string, unknown>).request_id === requestId &&
        (event.payload as Record<string, unknown>).reason === "operator_confirmed_not_sent",
    ).length,
    1,
  );

  const repeated = invoke(
    [
      "run",
      "reconcile",
      runId,
      "--request-id",
      requestId,
      "--not-sent-confirmed",
      "--conversation-url",
      conversationUrl,
      "--json",
    ],
    context.environment,
  );
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).outcome, "already_confirmed");
  const repeatedEvents = await readEvents(runPaths(context.home, runId).events);
  assert.equal(
    repeatedEvents.filter((event) => event.type === "controller_turn_not_sent_confirmed").length,
    1,
  );
  assert.equal(
    repeatedEvents.filter(
      (event) =>
        event.type === "controller_turn_abandoned" &&
        (event.payload as Record<string, unknown>).reason === "operator_confirmed_not_sent",
    ).length,
    1,
  );

  const status = invoke(["run", "status", runId, "--json"], context.environment);
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).controller.reconciliation, {
    requiredReason: "CONTROLLER_SUBMISSION_AMBIGUOUS",
    operatorConfirmation: "not_sent_confirmed",
    abandonedRequestId: requestId,
    retryRequestId: null,
    promptHash,
    resendBlockedReason: null,
  });
  assert.equal(JSON.parse(status.stdout).safeNextAction, "retry");
});

test("run reconcile not-sent confirmation fails closed on identity and state conflicts", async () => {
  const context = await fixture();
  const conversationUrl = "https://chatgpt.com/c/cli-not-sent-guards";

  async function createAmbiguousRun(
    suffix: string,
    options: {
      selectedModelLabel?: string;
      secondPending?: boolean;
      responseReceived?: boolean;
      normallySubmitted?: boolean;
    } = {},
  ): Promise<{ runId: string; requestId: string }> {
    const runId = `run_cli_not_sent_guard_${suffix}`;
    const requestId = `msg_cli_not_sent_guard_${suffix}`;
    const prompt = `guard prompt ${suffix}`;
    const store = await RunStore.create({
      home: context.home,
      runId,
      initialState: initialRunState(runId, "", "caller"),
      reducer: reduceRunState,
    });
    await store.append("run_created", { request: `Guard ${suffix}` });
    await store.append("controller_conversation_bound", {
      request_id: "msg_prior",
      conversation_url: conversationUrl,
    });
    await store.append("controller_turn_requested", {
      round: 2,
      request_id: requestId,
      prompt,
      prompt_hash: commandHash(prompt),
      submission_checkpoint_contract: "write_ahead_v1",
    });
    await store.append("controller_turn_submission_started", {
      round: 2,
      request_id: requestId,
      submission_state: "submitting",
      conversation_url: conversationUrl,
      selected_model_label: options.selectedModelLabel ?? "Pro",
      composer_prompt_state: "inline_ready",
      baseline_user_message_count: 1,
      baseline_assistant_message_count: 1,
    });
    if (options.secondPending === true) {
      const secondPrompt = `second guard prompt ${suffix}`;
      await store.append("controller_turn_requested", {
        round: 3,
        request_id: `${requestId}_second`,
        prompt: secondPrompt,
        prompt_hash: commandHash(secondPrompt),
        submission_checkpoint_contract: "write_ahead_v1",
      });
    }
    if (options.responseReceived === true) {
      await store.append("controller_response_received", {
        round: 2,
        request_id: requestId,
        selected_model_label: "Pro",
        response_model_slug: "gpt-5-6-pro",
        model_evidence_source: "composer_and_response",
      });
    }
    if (options.normallySubmitted === true) {
      await store.append("controller_turn_submitted", {
        round: 2,
        request_id: requestId,
        submission_state: "submitted",
        conversation_url: conversationUrl,
        selected_model_label: "Pro",
        composer_prompt_state: "inline_ready",
        baseline_user_message_count: 1,
        baseline_assistant_message_count: 1,
      });
    } else {
      await store.append("run_failed", {
        code: "CONTROLLER_SUBMISSION_AMBIGUOUS",
        request_id: requestId,
        stage: "submitting",
        submission_state: "possibly_sent",
        conversation_url: conversationUrl,
      });
    }
    await store.snapshot();
    return { runId, requestId };
  }

  const cases = [
    {
      name: "request",
      setup: () => createAmbiguousRun("request"),
      requestId: (requestId: string) => `${requestId}_wrong`,
      conversation: conversationUrl,
      code: "CONTROLLER_RECONCILIATION_REQUEST_NOT_FOUND",
    },
    {
      name: "conversation",
      setup: () => createAmbiguousRun("conversation"),
      requestId: (requestId: string) => requestId,
      conversation: "https://chatgpt.com/c/another-conversation",
      code: "CONTROLLER_RECONCILIATION_CONVERSATION_MISMATCH",
    },
    {
      name: "model",
      setup: () =>
        createAmbiguousRun("model", { selectedModelLabel: "GPT-5" }),
      requestId: (requestId: string) => requestId,
      conversation: conversationUrl,
      code: "CONTROLLER_RECONCILIATION_MODEL_UNVERIFIED",
    },
    {
      name: "response",
      setup: () =>
        createAmbiguousRun("response", { responseReceived: true }),
      requestId: (requestId: string) => requestId,
      conversation: conversationUrl,
      code: "CONTROLLER_RECONCILIATION_SUPERSEDED",
    },
    {
      name: "other-pending",
      setup: () => createAmbiguousRun("other_pending", { secondPending: true }),
      requestId: (requestId: string) => requestId,
      conversation: conversationUrl,
      code: "OTHER_CONTROLLER_TURNS_PENDING",
    },
    {
      name: "normally-submitted",
      setup: () =>
        createAmbiguousRun("normally_submitted", { normallySubmitted: true }),
      requestId: (requestId: string) => requestId,
      conversation: conversationUrl,
      code: "CONTROLLER_NOT_SENT_STATE_INVALID",
    },
  ];

  for (const scenario of cases) {
    const { runId, requestId } = await scenario.setup();
    const before = await readEvents(runPaths(context.home, runId).events);
    const result = invoke(
      [
        "run",
        "reconcile",
        runId,
        "--request-id",
        scenario.requestId(requestId),
        "--not-sent-confirmed",
        "--conversation-url",
        scenario.conversation,
        "--json",
      ],
      context.environment,
    );
    assert.equal(result.status, 1, scenario.name);
    assert.match(result.stderr, new RegExp(scenario.code), scenario.name);
    const after = await readEvents(runPaths(context.home, runId).events);
    assert.equal(after.length, before.length, scenario.name);
  }
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

test("jobs never exposes task, error, stdout, stderr, or combined worker output", async () => {
  const context = await fixture();
  const stdoutSentinel = "PRIVATE_STDOUT_SENTINEL";
  const stderrSentinel = "PRIVATE_STDERR_SENTINEL";
  const outputSentinel = "PRIVATE_COMBINED_OUTPUT_SENTINEL";
  const errorSentinel = "PRIVATE_ERROR_SENTINEL";
  await new JobStatusStore(context.home).write({
    jobId: "job_redacted",
    runId: "run_redacted",
    jobKey: "private_audit",
    lane: "default",
    mode: "advise",
    runnerId: "codex-default",
    model: "gpt-5.6-sol",
    provider: "openai",
    pid: 43211,
    phase: "finished",
    lastProgressAt: "2026-07-15T00:01:00.000Z",
    execution: "foreground",
    status: "failed",
    startedAt: "2026-07-15T00:00:00.000Z",
    finishedAt: "2026-07-15T00:01:00.000Z",
    result: {
      status: "failed",
      stdout: stdoutSentinel,
      stderr: stderrSentinel,
      output: outputSentinel,
      exitCode: 1,
      timedOut: false,
      cancelled: false,
      ambiguousSideEffects: false,
      emptyOutput: false,
      retryable: false,
      startedAt: "2026-07-15T00:00:00.000Z",
      finishedAt: "2026-07-15T00:01:00.000Z",
    },
    error: errorSentinel,
    privateDiagnostic: "PRIVATE_UNKNOWN_FIELD_SENTINEL",
  } as JobStatus & { privateDiagnostic: string });

  const json = invoke(["jobs", "--json"], context.environment);
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), [
    {
      jobId: "job_redacted",
      runId: "run_redacted",
      jobKey: "private_audit",
      lane: "default",
      mode: "advise",
      runnerId: "codex-default",
      model: "gpt-5.6-sol",
      provider: "openai",
      pid: 43211,
      phase: "finished",
      lastProgressAt: "2026-07-15T00:01:00.000Z",
      execution: "foreground",
      status: "failed",
      startedAt: "2026-07-15T00:00:00.000Z",
      finishedAt: "2026-07-15T00:01:00.000Z",
      observedStatus: "failed",
    },
  ]);
  const human = invoke(["jobs"], context.environment);
  assert.equal(human.status, 0, human.stderr);
  for (const sentinel of [
    stdoutSentinel,
    stderrSentinel,
    outputSentinel,
    errorSentinel,
    "PRIVATE_UNKNOWN_FIELD_SENTINEL",
  ]) {
    assert.doesNotMatch(json.stdout, new RegExp(sentinel));
    assert.doesNotMatch(human.stdout, new RegExp(sentinel));
  }
});

test("jobs keeps immutable run metadata from the authoritative event log", async () => {
  const context = await fixture();
  const runId = "run_authoritative_job_identity";
  const id = await seedOneRunningJob(context.home, runId);
  await new JobStatusStore(context.home).write({
    jobId: id,
    runId: "run_forged_identity",
    jobKey: "forged_key",
    lane: "forged_lane",
    mode: "work",
    execution: "foreground",
    status: "running",
    startedAt: "2026-07-15T00:00:00.000Z",
  });

  const result = invoke(["jobs", "--json"], context.environment);
  assert.equal(result.status, 0, result.stderr);
  const jobs = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.runId, runId);
  assert.equal(jobs[0]?.jobKey, "legacy_job");
  assert.equal(jobs[0]?.lane, "default");
  assert.equal(jobs[0]?.mode, "advise");
  assert.doesNotMatch(result.stdout, /forged/);
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
    execution: "foreground",
    status: "pending",
    startedAt: jobs[0]?.startedAt,
    observedStatus: "pending",
  });
  assert.doesNotMatch(result.stdout, /Inspect the exact caller task/);
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

test("jobs discovers an immutable terminal anchor when the replaceable status file is missing", async () => {
  const context = await fixture();
  const statusStore = new JobStatusStore(context.home);
  await statusStore.write({
    jobId: "job_terminal_anchor_only",
    runId: "run_terminal_anchor_only",
    jobKey: "terminal_anchor_only",
    execution: "foreground",
    status: "failed",
    startedAt: "2026-07-15T00:00:00.000Z",
    finishedAt: "2026-07-15T00:01:00.000Z",
    error: "DURABLE_TERMINAL_ANCHOR",
  });
  await unlink(statusStore.pathFor("job_terminal_anchor_only"));

  const result = invoke(["jobs", "--json"], context.environment);
  assert.equal(result.status, 0, result.stderr);
  const jobs = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.jobId, "job_terminal_anchor_only");
  assert.equal(jobs[0]?.status, "failed");
  assert.equal(jobs[0]?.observedStatus, "failed");
  assert.equal("error" in (jobs[0] ?? {}), false);
  assert.doesNotMatch(result.stdout, /DURABLE_TERMINAL_ANCHOR/);
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
      "routing [--json]",
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
    ["routing", "--help"],
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
