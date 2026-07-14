import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { jobId } from "../../src/core/ids.js";
import { initialRunState, reduceRunState } from "../../src/core/state-machine.js";
import { JobStatusStore } from "../../src/jobs/status.js";
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
  const store = await RunStore.create({
    home,
    runId,
    initialState: initialRunState(runId, ""),
    reducer: reduceRunState,
  });
  await store.append("run_created", { request: "Inspect a large project" });
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
    command_hash: "accepted-command",
  });
  for (const [index, status] of ["timed_out", "timed_out", "timed_out", "running"].entries()) {
    const spec = {
      job_key: `audit_${index + 1}`,
      lane: "default",
      mode: "advise" as const,
      task: `Audit ${index + 1}`,
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
    await store.append("job_status", { job_id: id, status });
  }
  return runId;
}

async function seedOneRunningJob(home: string, runId: string): Promise<string> {
  const store = await RunStore.create({
    home,
    runId,
    initialState: initialRunState(runId, ""),
    reducer: reduceRunState,
  });
  await store.append("run_created", { request: "Cancel one legacy job" });
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

test("doctor validates config, home, Node, and at least one route", async () => {
  const context = await fixture();
  const result = invoke(["doctor"], context.environment);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`CueLine ${await packageVersion()}`));
  assert.match(result.stdout, /status\s+ok/);
  assert.match(result.stdout, new RegExp(context.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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
    lastAcceptedAction: null,
    lastAcceptedRequestId: null,
    lastAcceptedJobKeys: [],
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
      jobId: id,
      execution: "foreground",
      status: "running",
      startedAt: "2026-07-15T00:00:00.000Z",
      observedStatus: "orphaned",
    },
  ]);
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
