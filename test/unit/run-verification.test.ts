import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyCueLineRun } from "../../src/api-run-verification.js";
import { jobId } from "../../src/core/ids.js";
import { initialRunState, reduceRunState } from "../../src/core/state-machine.js";
import { JobStatusStore } from "../../src/jobs/status.js";
import { runPaths } from "../../src/state/paths.js";
import { RunStore, STATE_PROTOCOL } from "../../src/state/store.js";

async function home(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "cueline-unit-verify-"));
}

async function seedRun(
  stateHome: string,
  runId: string,
): Promise<RunStore<ReturnType<typeof initialRunState>>> {
  const store = await RunStore.create({
    home: stateHome,
    runId,
    initialState: initialRunState(runId, "", "caller"),
    reducer: reduceRunState,
    now: () => new Date("2026-10-26T00:00:00.000Z"),
  });
  await store.append("run_created", { request: "verify request", executor: "caller" });
  return store;
}

async function rewriteSnapshot(
  stateHome: string,
  runId: string,
  change: (snapshot: Record<string, unknown>) => unknown,
): Promise<void> {
  const file = runPaths(stateHome, runId).snapshot;
  const snapshot = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  await writeFile(file, `${JSON.stringify(change(snapshot))}\n`, "utf8");
}

function codes(report: Awaited<ReturnType<typeof verifyCueLineRun>>): string[] {
  return report.findings.map((finding) => finding.code);
}

test("a run without a snapshot is verified and the snapshot is reported missing", async () => {
  const stateHome = await home();
  const runId = "run_unit_no_snapshot";
  await seedRun(stateHome, runId);

  const report = await verifyCueLineRun(runId, { home: stateHome });
  assert.equal(report.outcome, "verified");
  assert.equal(report.snapshot, "missing");
  assert.equal(report.marker, "valid");
  assert.deepEqual(report.eventLog, {
    readable: true,
    totalEvents: 1,
    authoritativeEvents: 1,
    lastSequence: 1,
  });
});

test("home is resolved from CUELINE_HOME when no explicit home is given", async () => {
  const stateHome = await home();
  const runId = "run_unit_env_home";
  await seedRun(stateHome, runId);

  const report = await verifyCueLineRun(runId, {
    environment: { CUELINE_HOME: stateHome, HOME: tmpdir() },
  });
  assert.equal(report.outcome, "verified");
  assert.equal(report.eventLog.totalEvents, 1);
});

test("a missing creation marker is a warning, not an error", async () => {
  const stateHome = await home();
  const runId = "run_unit_marker_missing";
  await seedRun(stateHome, runId);
  await rm(runPaths(stateHome, runId).creationMarker);

  const report = await verifyCueLineRun(runId, { home: stateHome });
  assert.equal(report.marker, "missing");
  assert.equal(report.outcome, "degraded");
  assert.deepEqual(codes(report), ["RUN_MARKER_MISSING"]);
  assert.equal(report.findings[0]?.severity, "warning");
  assert.equal(report.findings[0]?.surface, "marker");
});

test("a creation marker that cannot be read as a file is invalid", async () => {
  const stateHome = await home();
  const runId = "run_unit_marker_dir";
  await seedRun(stateHome, runId);
  const marker = runPaths(stateHome, runId).creationMarker;
  await rm(marker);
  await mkdir(marker);

  const report = await verifyCueLineRun(runId, { home: stateHome });
  assert.equal(report.marker, "invalid");
  assert.deepEqual(codes(report), ["RUN_MARKER_UNREADABLE"]);
});

test("a marker must match the run id exactly, including its trailing newline", async () => {
  const stateHome = await home();
  const runId = "run_unit_marker_newline";
  await seedRun(stateHome, runId);
  await writeFile(runPaths(stateHome, runId).creationMarker, runId, "utf8");

  const report = await verifyCueLineRun(runId, { home: stateHome });
  assert.equal(report.marker, "invalid");
  assert.deepEqual(codes(report), ["RUN_MARKER_MISMATCH"]);
});

test("snapshot records that are not objects or name another protocol or run are invalid", async () => {
  const cases: Array<[string, (snapshot: Record<string, unknown>) => unknown, string]> = [
    ["array", () => [], "SNAPSHOT_SCHEMA_INVALID"],
    ["null", () => null, "SNAPSHOT_SCHEMA_INVALID"],
    ["protocol", (snapshot) => ({ ...snapshot, protocol: "cueline-state/0" }), "SNAPSHOT_PROTOCOL_MISMATCH"],
    ["run", (snapshot) => ({ ...snapshot, run_id: "run_other" }), "SNAPSHOT_RUN_ID_MISMATCH"],
  ];
  for (const [label, change, code] of cases) {
    const stateHome = await home();
    const runId = `run_unit_snapshot_${label}`;
    const store = await seedRun(stateHome, runId);
    await store.snapshot();
    await rewriteSnapshot(stateHome, runId, change);

    const report = await verifyCueLineRun(runId, { home: stateHome });
    assert.equal(report.snapshot, "invalid", label);
    assert.equal(report.outcome, "degraded", label);
    assert.deepEqual(codes(report), [code], label);
  }
});

test("snapshot sequences outside the authoritative event range are invalid", async () => {
  for (const sequence of [-1, 1.5, 2, "1", null]) {
    const stateHome = await home();
    const runId = "run_unit_snapshot_sequence";
    const store = await seedRun(stateHome, runId);
    await store.snapshot();
    await rewriteSnapshot(stateHome, runId, (snapshot) => ({ ...snapshot, last_sequence: sequence }));

    const report = await verifyCueLineRun(runId, { home: stateHome });
    assert.equal(report.snapshot, "invalid", String(sequence));
    assert.deepEqual(codes(report), ["SNAPSHOT_SEQUENCE_INVALID"], String(sequence));
  }
});

test("a snapshot at sequence zero matches the initial replay state and is stale", async () => {
  const stateHome = await home();
  const runId = "run_unit_snapshot_zero";
  const store = await seedRun(stateHome, runId);
  await store.snapshot();
  await rewriteSnapshot(stateHome, runId, (snapshot) => ({
    ...snapshot,
    last_sequence: 0,
    state: initialRunState(runId, ""),
  }));

  const report = await verifyCueLineRun(runId, { home: stateHome });
  assert.equal(report.snapshot, "stale");
  assert.equal(report.outcome, "verified");
  assert.equal(STATE_PROTOCOL, JSON.parse(
    await readFile(runPaths(stateHome, runId).snapshot, "utf8"),
  ).protocol);
});

test("unreadable runtime ownership evidence degrades the report", async () => {
  const stateHome = await home();
  const runId = "run_unit_lease_invalid";
  await seedRun(stateHome, runId);
  await writeFile(runPaths(stateHome, runId).runtimeLease, "{not json", "utf8");

  const report = await verifyCueLineRun(runId, { home: stateHome });
  assert.equal(report.runtimeOwnership, "invalid");
  assert.equal(report.outcome, "degraded");
  assert.deepEqual(codes(report), ["RUNTIME_LEASE_INVALID"]);
  assert.equal(report.findings[0]?.surface, "runtime");
});

test("an unreadable job status file makes the run unreadable while keeping earlier warnings", async () => {
  const stateHome = await home();
  const runId = "run_unit_status_unreadable";
  const store = await seedRun(stateHome, runId);
  const spec = { job_key: "audit", lane: "default", mode: "advise" as const, task: "t", required: true };
  const id = jobId(runId, spec.job_key, spec);
  await store.append("job_registered", {
    job: { jobId: id, jobKey: spec.job_key, required: true, spec, status: "pending", output: null, error: null },
  });
  const jobFile = new JobStatusStore(stateHome).pathFor(id);
  await mkdir(path.dirname(jobFile), { recursive: true });
  await writeFile(jobFile, "{corrupt", "utf8");
  await rm(runPaths(stateHome, runId).creationMarker);

  const report = await verifyCueLineRun(runId, { home: stateHome });
  assert.equal(report.outcome, "unreadable");
  assert.equal(report.eventLog.readable, true);
  assert.deepEqual(codes(report), ["RUN_MARKER_MISSING", "RUN_STATUS_UNREADABLE"]);
  assert.equal(report.findings[1]?.severity, "error");
});

test("a job status that agrees with run events produces no job finding", async () => {
  const stateHome = await home();
  const runId = "run_unit_status_agrees";
  const store = await seedRun(stateHome, runId);
  const spec = { job_key: "audit", lane: "default", mode: "advise" as const, task: "t", required: true };
  const id = jobId(runId, spec.job_key, spec);
  await store.append("job_registered", {
    job: { jobId: id, jobKey: spec.job_key, required: true, spec, status: "pending", output: null, error: null },
  });
  await new JobStatusStore(stateHome).write({
    jobId: id,
    runId,
    jobKey: spec.job_key,
    execution: "foreground",
    status: "pending",
    startedAt: "2026-10-26T00:00:00.000Z",
  });

  const report = await verifyCueLineRun(runId, { home: stateHome });
  assert.equal(report.outcome, "verified");
  assert.deepEqual(codes(report), []);
});

test("verification of a run that was never created is unreadable and creates nothing", async () => {
  const stateHome = await home();
  const runId = "run_unit_absent";

  const report = await verifyCueLineRun(runId, { home: stateHome });
  assert.equal(report.outcome, "unreadable");
  assert.equal(report.marker, "missing");
  assert.equal(report.snapshot, "missing");
  assert.equal(report.runtimeOwnership, "missing");
  assert.deepEqual(report.eventLog, {
    readable: true,
    totalEvents: 0,
    authoritativeEvents: 0,
    lastSequence: 0,
  });
  assert.deepEqual(codes(report), ["RUN_MARKER_MISSING", "RUN_STATUS_UNREADABLE"]);
  assert.deepEqual(await readdir(stateHome), []);
});

test("snapshot JSON damage and replay mismatches are reported without exposing content", async () => {
  const cases: Array<[string, (file: string) => Promise<void>, string]> = [
    ["corrupt", (file) => writeFile(file, "{SECRET_SNAPSHOT", "utf8"), "SNAPSHOT_INVALID_JSON"],
    ["forged", async (file) => {
      const snapshot = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      await writeFile(file, JSON.stringify({ ...snapshot, state: { forged: "SECRET_SNAPSHOT" } }), "utf8");
    }, "SNAPSHOT_STATE_MISMATCH"],
  ];
  for (const [label, damage, code] of cases) {
    const stateHome = await home();
    const runId = `run_unit_snapshot_${label}`;
    const store = await seedRun(stateHome, runId);
    await store.snapshot();
    await damage(runPaths(stateHome, runId).snapshot);

    const report = await verifyCueLineRun(runId, { home: stateHome });
    assert.equal(report.snapshot, "invalid", label);
    assert.deepEqual(codes(report), [code], label);
    assert.doesNotMatch(JSON.stringify(report), /SECRET_SNAPSHOT/);
  }
});

test("a snapshot taken before later events is stale and a current one is valid", async () => {
  const stateHome = await home();
  const runId = "run_unit_snapshot_stale";
  const store = await seedRun(stateHome, runId);
  await store.snapshot();
  await store.append("notice", { message: "later event" });
  assert.equal((await verifyCueLineRun(runId, { home: stateHome })).snapshot, "stale");

  await store.snapshot();
  const report = await verifyCueLineRun(runId, { home: stateHome });
  assert.equal(report.snapshot, "valid");
  assert.equal(report.outcome, "verified");
  assert.equal(report.eventLog.lastSequence, 2);
});

test("a corrupt event segment is an unreadable event log", async () => {
  const stateHome = await home();
  const runId = "run_unit_event_corrupt";
  await seedRun(stateHome, runId);
  const segment = path.join(`${runPaths(stateHome, runId).events}.segments`, "0000000000000001.json");
  await writeFile(segment, "{SECRET_EVENT", "utf8");

  const report = await verifyCueLineRun(runId, { home: stateHome });
  assert.equal(report.outcome, "unreadable");
  assert.deepEqual(report.eventLog, { readable: false, totalEvents: 0, authoritativeEvents: 0, lastSequence: null });
  assert.equal(report.snapshot, "missing");
  assert.deepEqual(codes(report), ["EVENT_LOG_UNREADABLE"]);
  assert.doesNotMatch(JSON.stringify(report), /SECRET_EVENT/);
});

test("an uninterpretable event timestamp degrades the report", async () => {
  const stateHome = await home();
  const runId = "run_unit_event_timestamp";
  await seedRun(stateHome, runId);
  const segment = path.join(`${runPaths(stateHome, runId).events}.segments`, "0000000000000001.json");
  const event = JSON.parse(await readFile(segment, "utf8")) as Record<string, unknown>;
  await writeFile(segment, JSON.stringify({ ...event, timestamp: "yesterday-ish" }), "utf8");

  const report = await verifyCueLineRun(runId, { home: stateHome });
  assert.equal(report.outcome, "degraded");
  assert.deepEqual(codes(report), ["EVENT_TIMESTAMP_INVALID"]);
});

test("job status files that disagree with run events degrade the report, identity first", async () => {
  const cases: Array<[string, { runId?: string; jobKey?: string; status: "pending" | "succeeded" }, string]> = [
    ["other run", { runId: "run_other", status: "pending" }, "JOB_STATUS_IDENTITY_MISMATCH"],
    ["other key", { jobKey: "other", status: "succeeded" }, "JOB_STATUS_IDENTITY_MISMATCH"],
    ["status", { status: "succeeded" }, "JOB_STATUS_CONFLICT"],
  ];
  for (const [label, override, code] of cases) {
    const stateHome = await home();
    const runId = `run_unit_job_${label.replace(" ", "_")}`;
    const store = await seedRun(stateHome, runId);
    const spec = { job_key: "audit", lane: "default", mode: "advise" as const, task: "t", required: true };
    const id = jobId(runId, spec.job_key, spec);
    await store.append("job_registered", {
      job: { jobId: id, jobKey: spec.job_key, required: true, spec, status: "pending", output: null, error: null },
    });
    await new JobStatusStore(stateHome).write({
      jobId: id,
      runId: override.runId ?? runId,
      jobKey: override.jobKey ?? spec.job_key,
      execution: "foreground",
      status: override.status,
      startedAt: "2026-10-26T00:00:00.000Z",
      ...(override.status === "succeeded" ? { finishedAt: "2026-10-26T00:00:01.000Z" } : {}),
    });

    const report = await verifyCueLineRun(runId, { home: stateHome });
    assert.equal(report.outcome, "degraded", label);
    assert.deepEqual(codes(report), [code], label);
  }
});
