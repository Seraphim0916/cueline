import assert from "node:assert/strict";
import { access, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { CliIo } from "../../src/cli/io.js";
import { main } from "../../src/cli/main.js";
import { jobId } from "../../src/core/ids.js";
import { initialRunState, reduceRunState } from "../../src/core/state-machine.js";
import { JobStatusStore } from "../../src/jobs/status.js";
import { RunStore } from "../../src/state/store.js";
import { CUELINE_VERSION } from "../../src/version.js";

interface Invocation {
  code: number;
  stdout: string[];
  stderr: string[];
}

async function cli(args: string[], environment: NodeJS.ProcessEnv): Promise<Invocation> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) };
  const code = await main(args, environment, io);
  return { code, stdout, stderr };
}

async function fixture(): Promise<{ stateHome: string; config: string; environment: NodeJS.ProcessEnv }> {
  const stateHome = await mkdtemp(path.join(tmpdir(), "cueline-unit-cli-main-"));
  const config = path.join(stateHome, "routing.json");
  await writeFile(
    config,
    `${JSON.stringify({
      version: 1,
      lanes: {
        default: {
          enabled: true,
          candidates: [{ id: "node", argv: [process.execPath, "-e", "0"], task_input: "stdin" }],
        },
        disabled: {
          enabled: false,
          candidates: [{ id: "off", argv: [process.execPath, "-e", "0"], task_input: "stdin" }],
        },
      },
    })}\n`,
    "utf8",
  );
  return {
    stateHome,
    config,
    environment: { CUELINE_HOME: stateHome, HOME: stateHome, CUELINE_CONFIG: config },
  };
}

async function seedRun(
  stateHome: string,
  runId: string,
  options: { executor?: "caller" | "process"; timestamp?: string; complete?: boolean; job?: boolean } = {},
): Promise<string> {
  const executor = options.executor ?? "caller";
  const store = await RunStore.create({
    home: stateHome,
    runId,
    initialState: initialRunState(runId, "", executor),
    reducer: reduceRunState,
    now: () => new Date(options.timestamp ?? "2026-10-26T00:00:00.000Z"),
  });
  await store.append("run_created", { request: `request ${runId}`, executor });
  const spec = { job_key: "review", lane: "default", mode: "advise" as const, task: "t", required: true };
  const id = jobId(runId, spec.job_key, spec);
  if (options.job !== false) {
    await store.append("job_registered", {
      job: { jobId: id, jobKey: spec.job_key, required: true, spec, status: "pending", output: null, error: null },
    });
  }
  if (options.complete === true) await store.append("run_completed", { final_delivery_text: "done" });
  return id;
}

test("help, version, and path commands print without touching state", async () => {
  const { stateHome, config, environment } = await fixture();
  const before = await readdir(stateHome);

  for (const args of [[], ["help"], ["--help"], ["-h"], ["runs", "prune", "--apply", "--help"], ["run", "status", "-h"]]) {
    const result = await cli(args, environment);
    assert.equal(result.code, 0, args.join(" "));
    assert.equal(result.stdout.length, 1);
    assert.ok(result.stdout[0]!.length > 100, args.join(" "));
    assert.deepEqual(result.stderr, []);
  }
  for (const flag of ["version", "--version", "-v"]) {
    assert.deepEqual((await cli([flag], environment)).stdout, [CUELINE_VERSION]);
  }
  assert.deepEqual((await cli(["config", "path"], environment)).stdout, [config]);
  const api = await cli(["api", "path"], environment);
  assert.equal(path.basename(api.stdout[0]!), "api.js");
  await access(api.stdout[0]!);
  assert.deepEqual(await readdir(stateHome), before);
});

test("an unknown command exits 2 with usage on stderr only", async () => {
  const { environment } = await fixture();
  for (const args of [["frobnicate"], ["version", "extra"], ["config", "path", "x"], ["run", "status"]]) {
    const result = await cli(args, environment);
    assert.equal(result.code, 2, args.join(" "));
    assert.deepEqual(result.stdout, []);
    assert.equal(result.stderr.length, 3);
    assert.equal(result.stderr[0], `cueline: unrecognized command: ${args.join(" ")}`);
    assert.match(result.stderr[1]!, /^usage: cueline </);
    assert.equal(result.stderr[2], "try `cueline help`");
  }
});

test("install and uninstall reject invalid scopes before linking anything", async () => {
  const { stateHome, environment } = await fixture();
  const before = await readdir(stateHome);
  for (const command of ["install", "uninstall"]) {
    const both = await cli([command, "--codex-only", "--claude-only"], environment);
    assert.equal(both.code, 2);
    assert.equal(
      both.stderr[0],
      `CueLine: CLI_ARGUMENTS_INVALID: --codex-only and --claude-only are mutually exclusive; usage: cueline ${command} [--codex-only|--claude-only]`,
    );
    for (const args of [["--all"], ["--codex-only", "--codex-only"]]) {
      const rejected = await cli([command, ...args], environment);
      assert.equal(rejected.code, 2);
      assert.equal(rejected.stderr[0], `CueLine: CLI_ARGUMENTS_INVALID: usage: cueline ${command} [--codex-only|--claude-only]`);
    }
  }
  assert.deepEqual(await readdir(stateHome), before);
});

test("self-test validates arguments and reports a refused nested run in both formats", async () => {
  const { environment } = await fixture();
  const badArgs = await cli(["self-test", "--yaml"], environment);
  assert.equal(badArgs.code, 2);
  assert.equal(badArgs.stderr[0], "CueLine: CLI_ARGUMENTS_INVALID: usage: cueline self-test [--json]");

  const nested = { ...environment, CUELINE_DEPTH: "1" };
  const text = await cli(["self-test"], nested);
  assert.equal(text.code, 1);
  assert.deepEqual(text.stdout, ["offline self-test failed: NESTED_ROUTING_REJECTED"]);
  const json = await cli(["self-test", "--json"], nested);
  assert.equal(json.code, 1);
  assert.equal(JSON.parse(json.stdout.join("\n")).findings[0].code, "NESTED_ROUTING_REJECTED");
});

test("jobs lists persisted job records in text and JSON", async () => {
  const { stateHome, environment } = await fixture();
  assert.deepEqual((await cli(["jobs"], environment)).stdout, ["No jobs."]);
  assert.deepEqual(JSON.parse((await cli(["jobs", "--json"], environment)).stdout.join("\n")), []);

  const id = await seedRun(stateHome, "run_jobs");
  await new JobStatusStore(stateHome).write({
    jobId: id,
    runId: "run_jobs",
    jobKey: "review",
    lane: "default",
    mode: "advise",
    execution: "foreground",
    status: "pending",
    startedAt: "2026-10-26T00:00:00.000Z",
  });
  const text = await cli(["jobs"], environment);
  assert.equal(text.code, 0);
  assert.equal(text.stdout.length, 1);
  assert.match(
    text.stdout[0]!,
    new RegExp(`^${id}\\trun_jobs\\treview\\tdefault\\tadvise\\t-\\tforeground\\t\\w+\\t2026-10-26T00:00:00.000Z\\trunner=-\\tmodel=-\\tprovider=-\\tphase=-\\tprogress=-$`),
  );
  const json = JSON.parse((await cli(["jobs", "--json"], environment)).stdout.join("\n")) as Array<{ jobId: string }>;
  assert.deepEqual(json.map((job) => job.jobId), [id]);
  assert.equal((await cli(["jobs", "--json", "extra"], environment)).code, 2);
});

test("protocol lint checks the expected envelope against enabled lanes only", async () => {
  const { stateHome, environment } = await fixture();
  const file = path.join(stateHome, "command.txt");
  const envelope = (lane: string) =>
    `<CueLineControl>${JSON.stringify({
      protocol: "cueline/0.1",
      run_id: "run_lint",
      round: 1,
      request_id: "req_1",
      action: "dispatch",
      jobs: [{ job_key: "k", lane, mode: "advise", task: "t", required: true }],
    })}</CueLineControl>`;
  const expected = ["--run-id", "run_lint", "--round", "1", "--request-id", "req_1"];

  for (const args of [
    [],
    ["--run-id", "run_lint", "--request-id", "req_1"],
    ["--run-id", "run_lint", "--round", "0", "--request-id", "req_1"],
    ["--run-id", "run_lint", "--round", "1.5", "--request-id", "req_1"],
    ["--run-id", "", "--round", "1", "--request-id", "req_1"],
    [...expected, "--run-id", "again"],
    [...expected, "--json", "--json"],
    [...expected, "--strict"],
  ]) {
    const rejected = await cli(["protocol", "lint", file, ...args], environment);
    assert.equal(rejected.code, 2, args.join(" "));
    assert.match(rejected.stderr[0]!, /usage: cueline protocol lint <file>/);
  }

  await writeFile(file, envelope("default"), "utf8");
  const valid = await cli(["protocol", "lint", file, ...expected], environment);
  assert.equal(valid.code, 0, valid.stdout.join("\n"));
  assert.deepEqual(valid.stdout, ["valid\tyes", "format\tenvelope", "action\tdispatch"]);

  await writeFile(file, envelope("disabled"), "utf8");
  const disabled = await cli(["protocol", "lint", file, ...expected, "--json"], environment);
  assert.equal(disabled.code, 1);
  const report = JSON.parse(disabled.stdout.join("\n")) as { version: string; valid: boolean; issues: unknown[] };
  assert.equal(report.version, CUELINE_VERSION);
  assert.equal(report.valid, false);
  assert.ok(report.issues.length > 0);
  const disabledText = await cli(["protocol", "lint", file, ...expected], environment);
  assert.ok(disabledText.stdout.some((line) => line.startsWith("issue\terror\t")), disabledText.stdout.join("\n"));

  const missing = await cli(["protocol", "lint", path.join(stateHome, "absent.txt"), ...expected], environment);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr[0]!, /^CueLine: /);
});

test("runs prune validates ages and states and suggests --apply only when something is eligible", async () => {
  const { stateHome, environment } = await fixture();
  for (const args of [
    ["--older-than-days", "-1"],
    ["--older-than-days", "3651"],
    ["--older-than-days", "NaN"],
    ["--older-than-days", " "],
    ["--older-than-days", "1", "--older-than-days", "2"],
    ["--state", "running"],
    ["--apply", "--apply"],
    ["--force"],
  ]) {
    const rejected = await cli(["runs", "prune", ...args], environment);
    assert.equal(rejected.code, 2, args.join(" "));
    assert.match(rejected.stderr[0]!, /usage: cueline runs prune/);
  }

  await seedRun(stateHome, "run_old_done", { timestamp: "2020-01-01T00:00:00.000Z", complete: true, job: false });
  const dry = await cli(
    ["runs", "prune", "--older-than-days", "1", "--state", "complete", "--state", "complete"],
    environment,
  );
  assert.equal(dry.code, 0);
  assert.match(dry.stdout[0]!, /^prune\tmode=dry-run\tcutoff=\S+\tstates=complete$/);
  assert.ok(dry.stdout.some((line) => line.startsWith("run\trun_old_done\teligible\t")), dry.stdout.join("\n"));
  assert.equal(dry.stdout.at(-1), "next\trerun with --apply to delete the eligible runs");

  const json = await cli(["runs", "prune", "--older-than-days", "0", "--json"], environment);
  const parsed = JSON.parse(json.stdout.join("\n")) as { schema: string; version: string; apply: boolean };
  assert.equal(parsed.schema, "cueline-runs-prune/1");
  assert.equal(parsed.version, CUELINE_VERSION);
  assert.equal(parsed.apply, false);

  const none = await cli(["runs", "prune", "--older-than-days", "3650"], environment);
  assert.match(none.stdout.at(-1)!, /^summary\tpruned=0\teligible=0\tkept=1\t/);
  assert.ok(none.stdout.includes("run\trun_old_done\tkept\ttoo_recent\tcomplete\t2020-01-01T00:00:00.000Z"), none.stdout.join("\n"));
});

test("runs sweep renders decisions and its JSON schema", async () => {
  const { stateHome, environment } = await fixture();
  await seedRun(stateHome, "run_stale", { timestamp: "2020-01-01T00:00:00.000Z" });
  const dry = await cli(["runs", "sweep", "--stale-hours", "1"], environment);
  assert.equal(dry.code, 0);
  assert.match(dry.stdout[0]!, /^sweep\tmode=dry-run\tcutoff=/);
  assert.ok(
    dry.stdout.some((line) => /^run\trun_stale\teligible\t-\trunning\t\w+\t2020-01-01T00:00:00.000Z$/.test(line)),
    dry.stdout.join("\n"),
  );
  assert.equal(dry.stdout.at(-1), "next\trerun with --apply to close the eligible runs");
  const json = await cli(["runs", "sweep", "--json"], environment);
  assert.equal(JSON.parse(json.stdout.join("\n")).schema, "cueline-runs-sweep/1");
  assert.equal((await cli(["runs", "sweep", "--stale-hours", "8761"], environment)).code, 2);
});

test("run status renders every summary line and the JSON view", async () => {
  const { stateHome, environment } = await fixture();
  await seedRun(stateHome, "run_status");
  const text = await cli(["run", "status", "run_status"], environment);
  assert.equal(text.code, 0);
  const keys = text.stdout.map((line) => line.split("\t")[0]);
  assert.deepEqual(keys, [
    "run", "version", "status", "executor", "process_authorized", "phase", "runtime",
    "sequence", "controller", "jobs", "job", "cancellation", "continue", "next",
  ]);
  assert.ok(text.stdout.includes("status\trunning"));
  assert.ok(text.stdout.includes("process_authorized\tno"));
  assert.ok(text.stdout.includes("sequence\t2"));
  assert.match(text.stdout.find((line) => line.startsWith("controller\t"))!, /^controller\tno_response_accepted\tpending=0\t/);
  assert.match(text.stdout.find((line) => line.startsWith("jobs\t"))!, /^jobs\ttotal=1\tpending=1\t/);
  assert.ok(text.stdout.includes("cancellation\trun=none\tjobs=0"));

  const json = JSON.parse((await cli(["run", "status", "run_status", "--json"], environment)).stdout.join("\n")) as {
    version: string;
    runId: string;
  };
  assert.equal(json.version, CUELINE_VERSION);
  assert.equal(json.runId, "run_status");

  const missing = await cli(["run", "status", "run_absent"], environment);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr[0]!, /^CueLine: [A-Z_]+: /);
});

test("run cancel and stop settle a caller run; job cancel on a terminal run is a no-op", async () => {
  const { stateHome, environment } = await fixture();
  await seedRun(stateHome, "run_cancel");
  const cancel = await cli(["run", "cancel", "run_cancel"], environment);
  assert.equal(cancel.code, 0);
  assert.match(cancel.stdout[0]!, /^run_cancel\t(cancelled|requested)\taffected_jobs=\d+$/);
  const again = await cli(["run", "stop", "run_cancel", "--json"], environment);
  assert.equal(JSON.parse(again.stdout.join("\n")).outcome, "already_terminal");

  const id = await seedRun(stateHome, "run_done", { complete: true });
  const job = await cli(["job", "cancel", "run_done", id], environment);
  assert.deepEqual(job.stdout, [`run_done\t${id}\talready_terminal`]);
  const jobJson = await cli(["job", "cancel", "run_done", id, "--json"], environment);
  assert.equal(JSON.parse(jobJson.stdout.join("\n")).outcome, "already_terminal");
  assert.equal((await cli(["run", "cancel", "run_done", "--yaml"], environment)).code, 2);
});

test("runtime takeover and reconciliation report terminal runs without changing them", async () => {
  const { stateHome, environment } = await fixture();
  await seedRun(stateHome, "run_terminal", { executor: "process", complete: true });
  const takeover = await cli(["run", "takeover", "run_terminal"], environment);
  assert.equal(takeover.code, 0);
  assert.deepEqual(takeover.stdout, ["run_terminal\talready_terminal\tnext=none"]);
  const takeoverJson = await cli(["run", "takeover", "run_terminal", "--json"], environment);
  assert.equal(JSON.parse(takeoverJson.stdout.join("\n")).outcome, "already_terminal");

  const reconcile = await cli(["run", "reconcile-runtime", "run_terminal"], environment);
  assert.equal(reconcile.code, 0);
  assert.match(reconcile.stdout[0]!, /^run_terminal\talready_terminal\taffected_jobs=0\tsurviving_jobs=0$/);
  const reconcileJson = await cli(["run", "reconcile-runtime", "run_terminal", "--json"], environment);
  assert.equal(JSON.parse(reconcileJson.stdout.join("\n")).outcome, "already_terminal");
});

test("retry authorization and manual reconcile reject malformed evidence before any state read", async () => {
  const { environment } = await fixture();
  const hash = "a".repeat(64);
  const base = ["--request-id", "req_1", "--round", "1", "--conversation-url", "https://chatgpt.com/c/x"];
  for (const command of ["authorize-delivery-retry", "authorize-response-retry"]) {
    for (const args of [
      [...base],
      [...base, "--evidence-hash", "A".repeat(64)],
      [...base, "--evidence-hash", "a".repeat(63)],
      ["--request-id", "req_1", "--round", "0", "--conversation-url", "u", "--evidence-hash", hash],
      [...base, "--evidence-hash", hash, "--request-id", "again"],
      [...base, "--evidence-hash", hash, "--unknown"],
    ]) {
      const rejected = await cli(["run", command, "run_x", ...args], environment);
      assert.equal(rejected.code, 2, `${command} ${args.join(" ")}`);
      assert.match(rejected.stderr[0]!, new RegExp(`usage: cueline run ${command} <run-id>`));
    }
  }
  for (const args of [
    ["--request-id", "req_1"],
    ["--manual-send-confirmed"],
    ["--request-id", "req_1", "--manual-send-confirmed", "--not-sent-confirmed"],
    ["--request-id", "req_1", "--not-sent-confirmed", "--misdirected-conversation-url", "u"],
    ["--request-id", "req_1", "--manual-send-confirmed", "--bogus"],
  ]) {
    const rejected = await cli(["run", "reconcile", "run_x", ...args], environment);
    assert.equal(rejected.code, 2, args.join(" "));
    assert.match(rejected.stderr[0]!, /usage: cueline run reconcile <run-id>/);
  }
});

test("a valid retry authorization or reconcile on an unknown run fails with exit 1", async () => {
  const { environment } = await fixture();
  const authorize = await cli(
    [
      "run", "authorize-response-retry", "run_absent", "--request-id", "req_1", "--round", "1",
      "--conversation-url", "https://chatgpt.com/c/x", "--evidence-hash", "b".repeat(64),
    ],
    environment,
  );
  assert.equal(authorize.code, 1);
  assert.match(authorize.stderr[0]!, /^CueLine: /);
  const reconcile = await cli(
    ["run", "reconcile", "run_absent", "--request-id", "req_1", "--not-sent-confirmed"],
    environment,
  );
  assert.equal(reconcile.code, 1);
  assert.match(reconcile.stderr[0]!, /^CueLine: /);
});

test("observation commands are dispatched through main", async () => {
  const { stateHome, environment } = await fixture();
  await seedRun(stateHome, "run_observed");
  const verify = await cli(["run", "verify", "run_observed"], environment);
  assert.equal(verify.code, 0);
  assert.equal(verify.stdout[1], "outcome\tverified");
  const usage = await cli(["run", "graph", "run_observed", "--limit", "0"], environment);
  assert.equal(usage.code, 2);
});
