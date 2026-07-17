import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../../src/cli/main.js";
import { runOfflineSelfTest } from "../../src/diagnostics/offline-self-test.js";

function cleanEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.CUELINE_DEPTH;
  return environment;
}

test("offline self-test exercises the isolated controller loop and durable verifier", async () => {
  const report = await runOfflineSelfTest(cleanEnvironment());

  assert.equal(report.status, "ok");
  assert.deepEqual(report.checks, {
    controllerRounds: 2,
    completedJobs: 1,
    finalDelivery: true,
    durableRunVerification: true,
  });
  assert.deepEqual(report.findings, []);
});

test("offline self-test refuses nested routing without mutating caller state", async () => {
  const report = await runOfflineSelfTest({
    ...cleanEnvironment(),
    CUELINE_DEPTH: "1",
  });

  assert.equal(report.status, "failed");
  assert.equal(report.findings[0]?.code, "NESTED_ROUTING_REJECTED");
  assert.deepEqual(report.checks, {
    controllerRounds: 0,
    completedJobs: 0,
    finalDelivery: false,
    durableRunVerification: false,
  });
});

test("self-test CLI emits a stable, sanitized JSON report", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await main(["self-test", "--json"], cleanEnvironment(), {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(stderr, []);
  assert.equal(stdout.length, 1);
  const report = JSON.parse(stdout[0] ?? "null") as Record<string, unknown>;
  assert.equal(report.schema, "cueline-offline-self-test/1");
  assert.equal(report.status, "ok");
  assert.equal(JSON.stringify(report).includes("cueline-offline-self-test-home-"), false);
  assert.equal(JSON.stringify(report).includes("CUELINE_OFFLINE_WORKER_OK"), false);
});

test("self-test CLI rejects unknown arguments", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await main(["self-test", "--verbose"], cleanEnvironment(), {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 2);
  assert.deepEqual(stdout, []);
  assert.match(stderr.join("\n"), /usage: cueline self-test \[--json\]/);
});
