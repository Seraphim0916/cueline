import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyCueLineRun } from "../../src/api.js";
import { jobId } from "../../src/core/ids.js";
import { initialRunState, reduceRunState } from "../../src/core/state-machine.js";
import { JobStatusStore } from "../../src/jobs/status.js";
import { readEvents } from "../../src/state/event-log.js";
import { runPaths } from "../../src/state/paths.js";
import { RunStore } from "../../src/state/store.js";

async function home(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "cueline-run-verify-"));
}

async function seedRun(stateHome: string, runId: string): Promise<RunStore<ReturnType<typeof initialRunState>>> {
  const store = await RunStore.create({
    home: stateHome,
    runId,
    initialState: initialRunState(runId, "", "caller"),
    reducer: reduceRunState,
    now: () => new Date("2026-07-15T04:00:00.000Z"),
  });
  await store.append("run_created", {
    request: "PRIVATE VERIFY REQUEST",
    executor: "caller",
  });
  return store;
}

test("verifies marker, event replay, snapshot, runtime, and job evidence without mutation", async () => {
  const stateHome = await home();
  const runId = "run_verify_healthy";
  const store = await seedRun(stateHome, runId);
  await store.append("run_completed", { final_delivery_text: "PRIVATE VERIFY RESULT" });
  await store.snapshot();
  const paths = runPaths(stateHome, runId);
  const before = await readEvents(paths.events);

  const report = await verifyCueLineRun(runId, { home: stateHome });

  assert.deepEqual(report, {
    runId,
    outcome: "verified",
    marker: "valid",
    eventLog: {
      readable: true,
      totalEvents: 2,
      authoritativeEvents: 2,
      lastSequence: 2,
    },
    snapshot: "valid",
    runtimeOwnership: "missing",
    findings: [],
  });
  assert.deepEqual(await readEvents(paths.events), before);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE VERIFY|conversation|output/i);
});

test("accepts a valid stale snapshot because the event log remains authoritative", async () => {
  const stateHome = await home();
  const runId = "run_verify_stale_snapshot";
  const store = await seedRun(stateHome, runId);
  await store.snapshot();
  await store.append("run_failed", { code: "EXPECTED_LATER_EVENT" });

  const report = await verifyCueLineRun(runId, { home: stateHome });

  assert.equal(report.outcome, "verified");
  assert.equal(report.snapshot, "stale");
  assert.deepEqual(report.findings, []);
});

test("degrades on corrupt optional snapshot and mismatched creation marker", async () => {
  const stateHome = await home();
  const runId = "run_verify_degraded";
  await seedRun(stateHome, runId);
  const paths = runPaths(stateHome, runId);
  await writeFile(paths.snapshot, "{PRIVATE_CORRUPT_SNAPSHOT", "utf8");
  await writeFile(paths.creationMarker, "run_someone_else\n", "utf8");

  const report = await verifyCueLineRun(runId, { home: stateHome });

  assert.equal(report.outcome, "degraded");
  assert.equal(report.marker, "invalid");
  assert.equal(report.snapshot, "invalid");
  assert.deepEqual(report.findings.map((finding) => finding.code), [
    "RUN_MARKER_MISMATCH",
    "SNAPSHOT_INVALID_JSON",
  ]);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_CORRUPT_SNAPSHOT|run_someone_else/);
});

test("returns a static unreadable report for broken event segments without leaking content", async () => {
  const stateHome = await home();
  const runId = "run_verify_unreadable";
  await seedRun(stateHome, runId);
  const paths = runPaths(stateHome, runId);
  await mkdir(`${paths.events}.segments`, { recursive: true });
  await writeFile(
    path.join(`${paths.events}.segments`, "0000000000000002.json"),
    "{PRIVATE_EVENT_SENTINEL",
    "utf8",
  );

  const report = await verifyCueLineRun(runId, { home: stateHome });

  assert.equal(report.outcome, "unreadable");
  assert.equal(report.eventLog.readable, false);
  assert.deepEqual(report.findings.map((finding) => finding.code), [
    "EVENT_LOG_UNREADABLE",
  ]);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_EVENT_SENTINEL/);
});

test("detects a snapshot whose state does not match authoritative replay", async () => {
  const stateHome = await home();
  const runId = "run_verify_snapshot_mismatch";
  const store = await seedRun(stateHome, runId);
  await store.snapshot();
  const paths = runPaths(stateHome, runId);
  const snapshot = JSON.parse(await readFile(paths.snapshot, "utf8")) as Record<string, unknown>;
  snapshot.state = { forged: "PRIVATE_FORGED_STATE" };
  await writeFile(paths.snapshot, `${JSON.stringify(snapshot)}\n`, "utf8");

  const report = await verifyCueLineRun(runId, { home: stateHome });

  assert.equal(report.outcome, "degraded");
  assert.equal(report.snapshot, "invalid");
  assert.deepEqual(report.findings.map((finding) => finding.code), [
    "SNAPSHOT_STATE_MISMATCH",
  ]);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_FORGED_STATE/);
});

test("reports a snapshot with no state as invalid instead of throwing", async () => {
  const stateHome = await home();
  const runId = "run_verify_snapshot_missing_state";
  const store = await seedRun(stateHome, runId);
  await store.snapshot();
  const paths = runPaths(stateHome, runId);
  const snapshot = JSON.parse(await readFile(paths.snapshot, "utf8")) as Record<string, unknown>;
  delete snapshot.state;
  await writeFile(paths.snapshot, `${JSON.stringify(snapshot)}\n`, "utf8");

  const report = await verifyCueLineRun(runId, { home: stateHome });

  assert.equal(report.outcome, "degraded");
  assert.equal(report.snapshot, "invalid");
  assert.deepEqual(report.findings.map((finding) => finding.code), [
    "SNAPSHOT_SCHEMA_INVALID",
  ]);
});

test("degrades when an event timestamp cannot be interpreted", async () => {
  const stateHome = await home();
  const runId = "run_verify_timestamp";
  await seedRun(stateHome, runId);
  const paths = runPaths(stateHome, runId);
  const segment = path.join(`${paths.events}.segments`, "0000000000000001.json");
  const event = JSON.parse(await readFile(segment, "utf8")) as Record<string, unknown>;
  event.timestamp = "PRIVATE_NOT_A_TIMESTAMP";
  await writeFile(segment, `${JSON.stringify(event)}\n`, "utf8");

  const report = await verifyCueLineRun(runId, { home: stateHome });

  assert.equal(report.outcome, "degraded");
  assert.deepEqual(report.findings.map((finding) => finding.code), [
    "EVENT_TIMESTAMP_INVALID",
  ]);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_NOT_A_TIMESTAMP/);
});

test("degrades when a job status file claims another run identity", async () => {
  const stateHome = await home();
  const runId = "run_verify_job_identity";
  const store = await seedRun(stateHome, runId);
  const spec = {
    job_key: "verify_job",
    lane: "default",
    mode: "advise" as const,
    task: "PRIVATE JOB TASK",
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
  await new JobStatusStore(stateHome).write({
    jobId: id,
    runId: "run_wrong_identity",
    jobKey: "wrong_job_key",
    execution: "foreground",
    status: "pending",
    startedAt: "2026-07-15T04:00:00.000Z",
  });

  const report = await verifyCueLineRun(runId, { home: stateHome });

  assert.equal(report.outcome, "degraded");
  assert.deepEqual(report.findings.map((finding) => finding.code), [
    "JOB_STATUS_IDENTITY_MISMATCH",
  ]);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE JOB TASK|wrong_job_key/);
});

test("degrades when job status content conflicts with authoritative run events", async () => {
  const stateHome = await home();
  const runId = "run_verify_job_conflict";
  const store = await seedRun(stateHome, runId);
  const spec = {
    job_key: "verify_conflict",
    lane: "default",
    mode: "advise" as const,
    task: "PRIVATE CONFLICT TASK",
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
  await new JobStatusStore(stateHome).write({
    jobId: id,
    runId,
    jobKey: spec.job_key,
    execution: "foreground",
    status: "succeeded",
    startedAt: "2026-07-15T04:00:00.000Z",
    finishedAt: "2026-07-15T04:00:01.000Z",
  });

  const report = await verifyCueLineRun(runId, { home: stateHome });

  assert.equal(report.outcome, "degraded");
  assert.deepEqual(report.findings.map((finding) => finding.code), [
    "JOB_STATUS_CONFLICT",
  ]);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE CONFLICT TASK/);
});
