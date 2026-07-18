import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { startCueLineRun } from "../../src/api.js";
import { main } from "../../src/cli/main.js";
import { collectUpgradePreflight } from "../../src/diagnostics/upgrade-preflight.js";

async function environmentFor(home: string): Promise<NodeJS.ProcessEnv> {
  return {
    ...process.env,
    CUELINE_HOME: home,
    CUELINE_CONFIG: path.resolve("config/routing.default.json"),
  };
}

test("upgrade preflight is ready for a missing state home and creates nothing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cueline-upgrade-missing-"));
  const home = path.join(root, "not-created");
  const report = await collectUpgradePreflight({
    targetVersion: "1.0.0",
    environment: await environmentFor(home),
  });

  assert.equal(report.status, "ready");
  assert.equal(report.checks.stateHome.kind, "missing");
  await assert.rejects(lstat(home), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT",
  );
});

test("upgrade preflight blocks symlink and permissive state homes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cueline-upgrade-state-"));
  const target = path.join(root, "target");
  const linked = path.join(root, "linked");
  await chmod(root, 0o700);
  await writeFile(target, "do not follow");
  await symlink(target, linked);
  const linkedReport = await collectUpgradePreflight({
    targetVersion: "1.0.0",
    environment: await environmentFor(linked),
  });
  assert.equal(linkedReport.status, "blocked");
  assert.equal(linkedReport.findings[0]?.code, "STATE_HOME_SYMLINK_UNSAFE");

  const permissive = await mkdtemp(path.join(tmpdir(), "cueline-upgrade-permissive-"));
  await chmod(permissive, 0o755);
  const permissiveReport = await collectUpgradePreflight({
    targetVersion: "1.0.0",
    environment: await environmentFor(permissive),
  });
  assert.equal(permissiveReport.status, "blocked");
  assert.equal(
    permissiveReport.findings.some((finding) => finding.code === "STATE_HOME_PERMISSIONS_UNSAFE"),
    true,
  );
});

test("upgrade preflight blocks invalid versions, old Node, and bad routing", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-upgrade-invalid-"));
  await chmod(home, 0o700);
  const report = await collectUpgradePreflight({
    targetVersion: "0.1.0",
    nodeVersion: "20.0.0",
    environment: {
      ...(await environmentFor(home)),
      CUELINE_CONFIG: path.join(home, "missing.json"),
    },
  });

  assert.equal(report.status, "blocked");
  assert.deepEqual(
    report.findings.map((finding) => finding.code).sort(),
    ["NODE_VERSION_UNSUPPORTED", "ROUTING_CONFIG_INVALID", "TARGET_VERSION_DOWNGRADE"],
  );
});

test("upgrade preflight blocks a durable non-terminal run without changing it", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-upgrade-running-"));
  await chmod(home, 0o700);
  const environment = await environmentFor(home);
  const started = await startCueLineRun({
    request: "Remain pending for upgrade preflight",
    runId: "run_upgrade_preflight_pending",
    home,
    environment,
  });
  const marker = path.join(home, "runs", started.runId, "events.jsonl");
  const before = await lstat(marker);
  const report = await collectUpgradePreflight({ targetVersion: "1.0.0", environment });
  const after = await lstat(marker);

  assert.equal(report.status, "blocked");
  assert.equal(report.checks.runs.nonTerminal, 1);
  assert.equal(
    report.findings.some((finding) => finding.code === "NON_TERMINAL_RUNS_PRESENT"),
    true,
  );
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("upgrade preflight warns about pre-0.1.7 legacy job evidence without blocking", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-upgrade-legacy-"));
  await chmod(home, 0o700);
  const environment = await environmentFor(home);
  const jobsDir = path.join(home, "jobs");
  await mkdir(jobsDir, { recursive: true });
  // Pre-0.1.7 evidence: a result object without the `cancelled` field.
  await writeFile(
    path.join(jobsDir, "job_legacy.json"),
    JSON.stringify({ result: { status: "succeeded" } }),
  );
  // Current evidence carries `cancelled` and must not be counted as legacy.
  await writeFile(
    path.join(jobsDir, "job_current.json"),
    JSON.stringify({ result: { status: "succeeded", cancelled: false } }),
  );
  const report = await collectUpgradePreflight({ targetVersion: "1.0.0", environment });

  assert.equal(report.status, "ready");
  assert.equal(report.checks.runs.legacyJobEvidence, 1);
  assert.equal(
    report.findings.some((finding) => finding.code === "LEGACY_JOB_EVIDENCE_PRESENT"),
    true,
  );
  assert.equal(
    report.findings.some((finding) => finding.severity === "blocker"),
    false,
  );
});

test("upgrade preflight CLI emits structured JSON and rejects malformed arguments", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cueline-upgrade-cli-"));
  const home = path.join(root, "missing");
  const environment = await environmentFor(home);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await main(
    ["upgrade", "preflight", "--to", "1.0.0", "--json"],
    environment,
    { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
  );
  assert.equal(exitCode, 0);
  assert.deepEqual(stderr, []);
  assert.equal(JSON.parse(stdout[0] ?? "null").schema, "cueline-upgrade-preflight/1");

  const invalidErr: string[] = [];
  const invalidExit = await main(
    ["upgrade", "preflight", "--json"],
    environment,
    { stdout: () => undefined, stderr: (line) => invalidErr.push(line) },
  );
  assert.equal(invalidExit, 2);
  assert.match(invalidErr.join("\n"), /upgrade preflight --to <version>/);
});
