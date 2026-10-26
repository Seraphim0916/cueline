import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { handleHealthCommand } from "../../src/cli/health-commands.js";
import type { CliIo } from "../../src/cli/io.js";
import { CueLineError } from "../../src/core/errors.js";
import { CUELINE_VERSION } from "../../src/version.js";

const NEXT_MAJOR = `${Number(CUELINE_VERSION.split(".")[0]) + 1}.0.0`;

function candidate(id: string, executable: string): Record<string, unknown> {
  return { id, argv: [executable, "{task}"], task_input: "argv" };
}

const THREE_LANES = {
  version: 1,
  lanes: {
    default: { enabled: true, candidates: [candidate("missing-first", "missing-worker"), candidate("present", "fake-worker")] },
    offline: { enabled: true, candidates: [candidate("offline-only", "missing-worker")] },
    parked: { enabled: false, candidates: [candidate("parked-worker", "fake-worker")] },
  },
};

interface Fixture {
  stateHome: string;
  configPath: string;
  environment: NodeJS.ProcessEnv;
}

// Executables are only stat'ed for the execute bit by the router; nothing here runs them.
// The environment is built from scratch so the real HOME and PATH never leak in.
async function fixture(config: unknown = THREE_LANES, options: { executable?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "cueline-unit-health-"));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  if (options.executable !== false) {
    await writeFile(path.join(bin, "fake-worker"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  }
  const stateHome = path.join(root, "state");
  await mkdir(stateHome, { mode: 0o700 });
  const configPath = path.join(root, "routing.json");
  await writeFile(configPath, typeof config === "string" ? config : JSON.stringify(config), "utf8");
  return {
    stateHome,
    configPath,
    environment: { CUELINE_HOME: stateHome, CUELINE_CONFIG: configPath, PATH: bin },
  };
}

function collectingIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) }, stdout, stderr };
}

async function run(args: string[], environment: NodeJS.ProcessEnv) {
  const { io, stdout, stderr } = collectingIo();
  const code = await handleHealthCommand(args, environment, io);
  return { code, stdout, stderr };
}

test("unrelated or malformed commands are left for the next handler", async () => {
  const { environment } = await fixture();
  for (const args of [[], ["status"], ["routing", "--json", "extra"], ["routing", "--yaml"], ["doctor", "now"], ["doctor", "--json", "--json"], ["upgrade"]]) {
    const result = await run(args, environment);
    assert.equal(result.code, undefined, JSON.stringify(args));
    assert.deepEqual(result.stdout, []);
  }
});

test("routing reports available, unavailable and disabled lanes in config order", async () => {
  const { environment } = await fixture();
  const text = await run(["routing"], environment);
  assert.equal(text.code, 0);
  assert.deepEqual(text.stdout, [
    "default\tpresent\tavailable",
    "offline\t-\tunavailable (ROUTE_NO_CANDIDATE)",
    "parked\t-\tdisabled",
  ]);

  const json = await run(["routing", "--json"], environment);
  assert.equal(json.code, 0);
  const report = JSON.parse(json.stdout.join("\n"));
  assert.equal(report.schema, "cueline-routing/1");
  assert.equal(report.version, CUELINE_VERSION);
  assert.deepEqual(report.config, { path: environment.CUELINE_CONFIG, valid: true });
  assert.equal(report.availableLanes, 1);
  assert.deepEqual(report.lanes.map((lane: { name: string; status: string }) => [lane.name, lane.status]), [
    ["default", "available"],
    ["offline", "unavailable"],
    ["parked", "disabled"],
  ]);
  assert.equal(report.lanes[1].errorCode, "ROUTE_NO_CANDIDATE");
  assert.equal("errorCode" in report.lanes[0], false);
});

test("routing exits 1 when no lane has an executable candidate", async () => {
  const { environment } = await fixture(THREE_LANES, { executable: false });
  const result = await run(["routing"], environment);
  assert.equal(result.code, 1);
  assert.match(result.stdout[0] ?? "", /^default\t-\tunavailable \(/);
});

test("an invalid routing config is reported in text and JSON and exits 1", async () => {
  const { environment, configPath } = await fixture("{ not json");
  const text = await run(["routing"], environment);
  assert.equal(text.code, 1);
  assert.deepEqual(text.stdout, [`config\t${configPath}\tinvalid\tROUTING_CONFIG_INVALID`]);

  const json = await run(["routing", "--json"], environment);
  const report = JSON.parse(json.stdout.join("\n"));
  assert.deepEqual(report.config, { path: configPath, valid: false, errorCode: "ROUTING_CONFIG_INVALID" });
  assert.deepEqual(report.lanes, []);
  assert.equal(report.availableLanes, 0);
  assert.deepEqual(report.findings.map((finding: { code: string }) => finding.code), ["ROUTING_CONFIG_INVALID"]);

  const explain = await run(["routing", "explain"], environment);
  assert.equal(explain.code, 1);
  assert.deepEqual(explain.stdout, [`config\t${configPath}\tinvalid\tROUTING_CONFIG_INVALID`]);
  const explainJson = JSON.parse((await run(["routing", "explain", "default", "--json"], environment)).stdout.join("\n"));
  assert.equal(explainJson.schema, "cueline-routing-explain/0.1");
  assert.equal(explainJson.requestedLane, "default");
  assert.equal(explainJson.config.valid, false);
});

test("routing explain lists each candidate with its reason code", async () => {
  const { environment } = await fixture();
  const result = await run(["routing", "explain", "default"], environment);
  assert.equal(result.code, 0);
  assert.equal(result.stdout[0], "default\tpresent\tavailable");
  assert.equal(result.stdout.length, 3);
  assert.match(result.stdout[1] ?? "", /^candidate\t0\tmissing-first\t[A-Z_]+$/);
  assert.match(result.stdout[2] ?? "", /^candidate\t1\tpresent\t[A-Z_]+$/);

  const json = JSON.parse((await run(["routing", "explain", "--json"], environment)).stdout.join("\n"));
  assert.equal(json.schema, "cueline-routing-explain/0.1");
  assert.deepEqual(json.config, { path: environment.CUELINE_CONFIG, valid: true });
  assert.equal(json.requestedLane, null);
  assert.deepEqual(json.lanes.map((lane: { name: string }) => lane.name), ["default", "offline", "parked"]);
});

test("routing explain prints findings for an unknown lane and exits 1", async () => {
  const { environment } = await fixture();
  const result = await run(["routing", "explain", "nope"], environment);
  assert.equal(result.code, 1);
  assert.equal(result.stdout.length, 1);
  assert.match(result.stdout[0] ?? "", /^finding\tROUTE_LANE_UNKNOWN\t/);
});

test("routing explain rejects flags, duplicate lanes and duplicate --json", async () => {
  const { environment } = await fixture();
  for (const args of [
    ["routing", "explain", "--verbose"],
    ["routing", "explain", "a", "b"],
    ["routing", "explain", "--json", "--json"],
  ]) {
    await assert.rejects(
      run(args, environment),
      (error: unknown) =>
        error instanceof CueLineError &&
        error.code === "CLI_ARGUMENTS_INVALID" &&
        /routing explain/.test(error.message),
      JSON.stringify(args),
    );
  }
});

test("doctor is ok with an enabled lane even when no process runner is available", async () => {
  const { environment, stateHome } = await fixture(THREE_LANES, { executable: false });
  const json = await run(["doctor", "--json"], environment);
  const report = JSON.parse(json.stdout.join("\n"));
  assert.equal(report.schema, "cueline-doctor/1");
  assert.equal(report.home, stateHome);
  assert.deepEqual(report.caller, { ready: true, enabledLanes: 2 });
  assert.deepEqual(report.process, { availableLanes: 0 });
  assert.deepEqual(report.findings, []);
  assert.equal(report.status, "ok");
  assert.equal(json.code, 0);

  const text = await run(["doctor"], environment);
  assert.equal(text.code, 0);
  assert.deepEqual(text.stdout.slice(1), [
    "status\tok",
    `node\t${process.versions.node}\tok`,
    `config\t${environment.CUELINE_CONFIG}\tvalid`,
    `home\t${stateHome}`,
    "caller_ready\tyes",
    "caller_lanes\t2",
    "process_available_lanes\t0",
  ]);
  assert.equal(text.stdout[0], `CueLine ${CUELINE_VERSION}`);
});

test("doctor is degraded when every lane is disabled or the config is invalid", async () => {
  const disabled = await fixture({ version: 1, lanes: { parked: THREE_LANES.lanes.parked } });
  const disabledResult = await run(["doctor", "--json"], disabled.environment);
  assert.equal(disabledResult.code, 1);
  const disabledReport = JSON.parse(disabledResult.stdout.join("\n"));
  assert.equal(disabledReport.status, "degraded");
  assert.deepEqual(disabledReport.findings.map((finding: { code: string }) => finding.code), ["CALLER_LANES_UNAVAILABLE"]);

  const invalid = await fixture("[]");
  const invalidResult = await run(["doctor"], invalid.environment);
  assert.equal(invalidResult.code, 1);
  assert.ok(invalidResult.stdout.includes(`config\t${invalid.configPath}\tinvalid`));
  assert.ok(invalidResult.stdout.includes("caller_ready\tno"));
  assert.deepEqual(
    invalidResult.stdout.filter((line) => line.startsWith("finding\t")),
    ["finding\tROUTING_CONFIG_INVALID\tconfig\tRouting configuration could not be loaded."],
  );
});

test("doctor flags a group-readable state home with a shell-safe chmod hint", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(path.join(tmpdir(), "cueline-unit-health-quote-"));
  const stateHome = path.join(root, "it's state");
  await mkdir(stateHome, { mode: 0o700 });
  await chmod(stateHome, 0o750);
  const { environment } = await fixture();
  const result = await run(["doctor", "--json"], { ...environment, CUELINE_HOME: stateHome });
  const report = JSON.parse(result.stdout.join("\n"));
  // The unsafe home is a finding but does not by itself degrade caller readiness.
  assert.equal(report.status, "ok");
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].code, "STATE_HOME_PERMISSIONS_UNSAFE");
  assert.equal(report.findings[0].surface, "state");
  assert.match(report.findings[0].message, /mode 750;/);
  assert.ok(report.findings[0].message.endsWith(`chmod 700 '${stateHome.replaceAll("'", "'\\''")}'`));
});

test("upgrade preflight validates its arguments before collecting anything", async () => {
  const { environment } = await fixture();
  for (const args of [
    ["upgrade", "preflight"],
    ["upgrade", "preflight", "--json"],
    ["upgrade", "preflight", "--to"],
    ["upgrade", "preflight", "--to", "1.0.0", "--to", "2.0.0"],
    ["upgrade", "preflight", "--to", "1.0.0", "--json", "--json"],
    ["upgrade", "preflight", "--to", "1.0.0", "--force"],
  ]) {
    await assert.rejects(
      run(args, environment),
      (error: unknown) => error instanceof CueLineError && error.code === "CLI_ARGUMENTS_INVALID",
      JSON.stringify(args),
    );
  }
});

test("upgrade preflight prints the report and maps ready and blocked to exit codes", async () => {
  const { environment } = await fixture();
  const ready = await run(["upgrade", "preflight", "--to", NEXT_MAJOR], environment);
  assert.equal(ready.code, 0);
  assert.deepEqual(ready.stdout, [`upgrade ${CUELINE_VERSION} -> ${NEXT_MAJOR}\tready`]);

  const blocked = await run(["upgrade", "preflight", "--json", "--to", "v1"], environment);
  assert.equal(blocked.code, 1);
  const report = JSON.parse(blocked.stdout.join("\n"));
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.findings.map((finding: { code: string }) => finding.code), ["TARGET_VERSION_INVALID"]);

  const blockedText = await run(["upgrade", "preflight", "--to", "v1"], environment);
  assert.equal(blockedText.stdout[0], `upgrade ${CUELINE_VERSION} -> v1\tblocked`);
  assert.match(blockedText.stdout[1] ?? "", /^finding\tTARGET_VERSION_INVALID\tversion\t/);
});
