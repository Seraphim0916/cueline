import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";

import { runOfflineSelfTest } from "../../src/diagnostics/offline-self-test.js";
import { CUELINE_VERSION } from "../../src/version.js";

const PREFIXES = ["cueline-offline-self-test-home-", "cueline-offline-self-test-workspace-"];

async function selfTestDirectories(): Promise<string[]> {
  const entries = await readdir(tmpdir());
  return entries.filter((name) => PREFIXES.some((prefix) => name.startsWith(prefix))).sort();
}

function environmentWithoutDepth(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.CUELINE_DEPTH;
  return environment;
}

test("any CUELINE_DEPTH value, even empty, is refused before a temp directory is created", async () => {
  const before = await selfTestDirectories();
  for (const depth of ["1", "0", ""]) {
    const report = await runOfflineSelfTest({ ...environmentWithoutDepth(), CUELINE_DEPTH: depth });
    assert.deepEqual(report, {
      schema: "cueline-offline-self-test/1",
      version: CUELINE_VERSION,
      status: "failed",
      offline: true,
      checks: {
        controllerRounds: 0,
        completedJobs: 0,
        finalDelivery: false,
        durableRunVerification: false,
      },
      findings: [
        {
          code: "NESTED_ROUTING_REJECTED",
          message: "Offline self-test cannot run from inside another CueLine execution.",
        },
      ],
    });
  }
  assert.deepEqual(await selfTestDirectories(), before);
});

test("failed reports do not share a mutable checks object", async () => {
  const environment = { ...environmentWithoutDepth(), CUELINE_DEPTH: "1" };
  const first = await runOfflineSelfTest(environment);
  first.checks.controllerRounds = 99;
  const second = await runOfflineSelfTest(environment);
  assert.equal(second.checks.controllerRounds, 0);
});

test("the isolated loop passes every invariant and removes both temp directories", async () => {
  const before = await selfTestDirectories();
  const caller = environmentWithoutDepth();
  const snapshot = JSON.stringify(caller);

  const report = await runOfflineSelfTest(caller);
  assert.equal(report.status, "ok", JSON.stringify(report.findings));
  assert.equal(report.offline, true);
  assert.equal(report.version, CUELINE_VERSION);
  assert.deepEqual(report.checks, {
    controllerRounds: 2,
    completedJobs: 1,
    finalDelivery: true,
    durableRunVerification: true,
  });
  assert.deepEqual(report.findings, []);
  assert.deepEqual(await selfTestDirectories(), before);
  assert.equal(JSON.stringify(caller), snapshot, "the caller environment must not be mutated");
});
