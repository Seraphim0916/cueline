import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { initialRunState, reduceRunState } from "../../src/core/state-machine.js";
import {
  collectUpgradePreflight,
  type UpgradePreflightReport,
} from "../../src/diagnostics/upgrade-preflight.js";
import { RunStore } from "../../src/state/store.js";
import { CUELINE_VERSION } from "../../src/version.js";

const NOW = new Date("2026-10-26T00:00:00.000Z");
const CURRENT = CUELINE_VERSION.split(".").map(Number) as [number, number, number];
const NEXT_PATCH = `${CURRENT[0]}.${CURRENT[1]}.${CURRENT[2] + 1}`;
const NEXT_MAJOR = `${CURRENT[0] + 1}.0.0`;

interface Fixture {
  root: string;
  stateHome: string;
  environment: NodeJS.ProcessEnv;
}

// The environment is built from scratch so neither HOME nor the caller's PATH or
// CUELINE_* settings can leak into the report.
async function fixture(options: { createHome?: boolean; config?: unknown } = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "cueline-unit-preflight-"));
  const stateHome = path.join(root, "state");
  if (options.createHome !== false) await mkdir(stateHome, { mode: 0o700 });
  const configPath = path.join(root, "routing.json");
  await writeFile(
    configPath,
    JSON.stringify(
      options.config ?? {
        version: 1,
        lanes: {
          default: {
            enabled: true,
            candidates: [{ id: "worker", argv: ["worker", "{task}"], task_input: "argv" }],
          },
        },
      },
    ),
    "utf8",
  );
  return {
    root,
    stateHome,
    environment: { CUELINE_HOME: stateHome, CUELINE_CONFIG: configPath, PATH: path.join(root, "bin") },
  };
}

async function seedRun(stateHome: string, runId: string, terminal?: "complete" | "cancelled"): Promise<void> {
  const store = await RunStore.create({
    home: stateHome,
    runId,
    initialState: initialRunState(runId, "", "caller"),
    reducer: reduceRunState,
    now: () => NOW,
  });
  await store.append("run_created", { request: "preflight request", executor: "caller" });
  if (terminal === "complete") await store.append("run_completed", { final_delivery_text: "done" });
  if (terminal === "cancelled") await store.append("run_cancelled", { reason: "stopped" });
}

function codes(report: UpgradePreflightReport): string[] {
  return report.findings.map((finding) => finding.code);
}

test("a newer target with a valid config and no state home is ready", async () => {
  const { stateHome, environment } = await fixture({ createHome: false });
  const report = await collectUpgradePreflight({ targetVersion: NEXT_PATCH, environment, nodeVersion: "22.0.0" });
  assert.equal(report.schema, "cueline-upgrade-preflight/1");
  assert.equal(report.status, "ready");
  assert.equal(report.version, CUELINE_VERSION);
  assert.equal(report.targetVersion, NEXT_PATCH);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.checks.node, { version: "22.0.0", requirement: ">=22", ok: true });
  assert.equal(report.checks.config.valid, true);
  assert.deepEqual(report.checks.stateHome, { path: stateHome, kind: "missing", private: null });
  assert.deepEqual(report.checks.runs, { total: 0, nonTerminal: 0, unreadable: 0, legacyJobEvidence: 0 });
});

test("target versions are compared numerically, not lexically", async () => {
  const { environment } = await fixture();
  const ready = await collectUpgradePreflight({ targetVersion: NEXT_MAJOR, environment, nodeVersion: "24.1.0" });
  assert.deepEqual(codes(ready), []);

  const same = await collectUpgradePreflight({ targetVersion: CUELINE_VERSION, environment, nodeVersion: "22.0.0" });
  assert.deepEqual(codes(same), ["TARGET_VERSION_NOT_NEWER"]);
  assert.equal(same.findings[0]?.severity, "warning");
  // A warning alone does not block the upgrade.
  assert.equal(same.status, "ready");

  const older = CURRENT[2] > 0
    ? `${CURRENT[0]}.${CURRENT[1]}.${CURRENT[2] - 1}`
    : `${CURRENT[0]}.${CURRENT[1] - 1}.99`;
  const downgrade = await collectUpgradePreflight({ targetVersion: older, environment, nodeVersion: "22.0.0" });
  assert.deepEqual(codes(downgrade), ["TARGET_VERSION_DOWNGRADE"]);
  assert.equal(downgrade.status, "blocked");
});

test("only stable semantic versions are accepted as targets", async () => {
  const { environment } = await fixture();
  for (const targetVersion of ["", "1", "1.0", "v1.0.0", "1.0.0-rc.1", "1.0.0+build", "01.0.0", "1.0.0 ", "a.b.c"]) {
    const report = await collectUpgradePreflight({ targetVersion, environment, nodeVersion: "22.0.0" });
    assert.deepEqual(codes(report), ["TARGET_VERSION_INVALID"], JSON.stringify(targetVersion));
    assert.equal(report.status, "blocked");
    assert.equal(report.targetVersion, targetVersion);
  }
});

test("Node.js older than 22 or an unparseable version blocks the upgrade", async () => {
  const { environment } = await fixture();
  for (const [nodeVersion, ok] of [
    ["21.99.99", false],
    ["22.0.0", true],
    ["26.0.0", true],
    ["", false],
    ["latest", false],
  ] as const) {
    const report = await collectUpgradePreflight({ targetVersion: NEXT_PATCH, environment, nodeVersion });
    assert.equal(report.checks.node.ok, ok, nodeVersion);
    assert.deepEqual(codes(report), ok ? [] : ["NODE_VERSION_UNSUPPORTED"], nodeVersion);
  }
});

test("an unloadable routing configuration blocks without hiding the other checks", async () => {
  const { environment } = await fixture({ config: { version: 1, lanes: "not-an-object" } });
  const report = await collectUpgradePreflight({ targetVersion: "not-semver", environment, nodeVersion: "20.0.0" });
  assert.deepEqual(codes(report), ["TARGET_VERSION_INVALID", "NODE_VERSION_UNSUPPORTED", "ROUTING_CONFIG_INVALID"]);
  assert.equal(report.checks.config.valid, false);
  assert.equal(report.checks.config.path, environment.CUELINE_CONFIG);
});

test("a state home with group or other permission bits blocks and skips run inspection", async () => {
  if (process.platform === "win32") return;
  const { stateHome, environment } = await fixture();
  await seedRun(stateHome, "run_preflight_open");
  await chmod(stateHome, 0o750);
  const report = await collectUpgradePreflight({ targetVersion: NEXT_PATCH, environment, nodeVersion: "22.0.0" });
  assert.deepEqual(codes(report), ["STATE_HOME_PERMISSIONS_UNSAFE"]);
  assert.deepEqual(report.checks.stateHome, { path: stateHome, kind: "directory", private: false });
  // Runs are not listed through an unsafe home, so the open run is not counted.
  assert.equal(report.checks.runs.total, 0);
});

test("a symlinked or non-directory state home blocks", async () => {
  if (process.platform === "win32") return;
  const linked = await fixture({ createHome: false });
  const target = path.join(linked.root, "real-state");
  await mkdir(target, { mode: 0o700 });
  await symlink(target, linked.stateHome);
  const symlinkReport = await collectUpgradePreflight({
    targetVersion: NEXT_PATCH,
    environment: linked.environment,
    nodeVersion: "22.0.0",
  });
  assert.deepEqual(codes(symlinkReport), ["STATE_HOME_SYMLINK_UNSAFE"]);
  assert.equal(symlinkReport.checks.stateHome.kind, "symlink");
  assert.equal(symlinkReport.checks.stateHome.private, null);

  const file = await fixture({ createHome: false });
  await writeFile(file.stateHome, "not a directory", "utf8");
  const fileReport = await collectUpgradePreflight({
    targetVersion: NEXT_PATCH,
    environment: file.environment,
    nodeVersion: "22.0.0",
  });
  assert.deepEqual(codes(fileReport), ["STATE_HOME_NOT_DIRECTORY"]);
  assert.equal(fileReport.checks.stateHome.kind, "other");
});

test("an unreadable state home path is reported instead of treated as missing", async () => {
  const { root, environment } = await fixture({ createHome: false });
  const blocker = path.join(root, "file-parent");
  await writeFile(blocker, "x", "utf8");
  // lstat through a regular file fails with ENOTDIR, which is not "missing".
  const report = await collectUpgradePreflight({
    targetVersion: NEXT_PATCH,
    environment: { ...environment, CUELINE_HOME: path.join(blocker, "state") },
    nodeVersion: "22.0.0",
  });
  assert.deepEqual(codes(report), ["STATE_HOME_UNREADABLE"]);
  assert.equal(report.checks.stateHome.kind, "other");
});

test("terminal runs are ready; a running run blocks the upgrade", async () => {
  const { stateHome, environment } = await fixture();
  await seedRun(stateHome, "run_preflight_done", "complete");
  await seedRun(stateHome, "run_preflight_cancelled", "cancelled");
  const ready = await collectUpgradePreflight({ targetVersion: NEXT_PATCH, environment, nodeVersion: "22.0.0" });
  assert.deepEqual(codes(ready), []);
  assert.deepEqual(ready.checks.runs, { total: 2, nonTerminal: 0, unreadable: 0, legacyJobEvidence: 0 });
  assert.deepEqual(ready.checks.stateHome, { path: stateHome, kind: "directory", private: true });

  await seedRun(stateHome, "run_preflight_running");
  const blocked = await collectUpgradePreflight({ targetVersion: NEXT_PATCH, environment, nodeVersion: "22.0.0" });
  assert.deepEqual(codes(blocked), ["NON_TERMINAL_RUNS_PRESENT"]);
  assert.equal(blocked.checks.runs.total, 3);
  assert.equal(blocked.checks.runs.nonTerminal, 1);
  assert.equal(blocked.status, "blocked");
});

test("legacy job evidence is a warning counted only from .json and .terminal files", async () => {
  const { stateHome, environment } = await fixture();
  const jobs = path.join(stateHome, "jobs");
  await mkdir(jobs, { recursive: true, mode: 0o700 });
  const legacy = JSON.stringify({ jobId: "legacy", status: "succeeded", result: { status: "succeeded" } });
  const current = JSON.stringify({ jobId: "current", status: "succeeded", result: { cancelled: false } });
  await writeFile(path.join(jobs, "legacy-a.json"), legacy, "utf8");
  await writeFile(path.join(jobs, "legacy-b.terminal"), legacy, "utf8");
  await writeFile(path.join(jobs, "legacy-c.txt"), legacy, "utf8");
  await writeFile(path.join(jobs, "current.json"), current, "utf8");
  await writeFile(path.join(jobs, "corrupt.json"), "{not json", "utf8");
  await writeFile(path.join(jobs, "array.json"), JSON.stringify([{ result: {} }]), "utf8");
  await mkdir(path.join(jobs, "nested.json"));

  const report = await collectUpgradePreflight({ targetVersion: NEXT_PATCH, environment, nodeVersion: "22.0.0" });
  assert.equal(report.checks.runs.legacyJobEvidence, 2);
  assert.deepEqual(codes(report), ["LEGACY_JOB_EVIDENCE_PRESENT"]);
  assert.equal(report.findings[0]?.severity, "warning");
  assert.equal(report.status, "ready");
});
