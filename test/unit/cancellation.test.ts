import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CueLineError } from "../../src/core/errors.js";
import {
  readJobCancellations,
  readRunCancellation,
  requestJobCancellation,
  requestRunCancellation,
} from "../../src/state/cancellation.js";
import { runPaths } from "../../src/state/paths.js";

async function home(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "cueline-cancellation-record-"));
}

function hasInvalidRecordCode(error: unknown): boolean {
  return error instanceof CueLineError && error.code === "CANCELLATION_REQUEST_INVALID";
}

test("malformed cancellation JSON has one stable record error", async () => {
  const stateHome = await home();
  const runId = "run_invalid_cancellation_json";
  const target = runPaths(stateHome, runId).runCancellation;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "{not-json", "utf8");

  await assert.rejects(readRunCancellation(stateHome, runId), hasInvalidRecordCode);
});

test("cancellation records reject noncanonical timestamps and unknown fields", async () => {
  const invalidRecords = [
    {
      protocol: "cueline/cancellation/0.1",
      run_id: "run_invalid_cancellation_shape",
      target: "run",
      reason: "stop",
      requested_at: "yesterday",
    },
    {
      protocol: "cueline/cancellation/0.1",
      run_id: "run_invalid_cancellation_shape",
      target: "run",
      reason: "stop",
      requested_at: "2026-07-15T00:00:00.000Z",
      injected: true,
    },
  ];

  for (const record of invalidRecords) {
    const stateHome = await home();
    const target = runPaths(stateHome, record.run_id).runCancellation;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(record)}\n`, "utf8");
    await assert.rejects(
      readRunCancellation(stateHome, record.run_id),
      hasInvalidRecordCode,
    );
  }
});

test("job cancellation filename must match its durable job identity", async () => {
  const stateHome = await home();
  const runId = "run_mismatched_job_cancellation";
  const directory = runPaths(stateHome, runId).jobCancellationsDir;
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "job_expected.json"),
    `${JSON.stringify({
      protocol: "cueline/cancellation/0.1",
      run_id: runId,
      target: "job",
      job_id: "job_other",
      reason: "stop",
      requested_at: "2026-07-15T00:00:00.000Z",
    })}\n`,
    "utf8",
  );

  await assert.rejects(readJobCancellations(stateHome, runId), hasInvalidRecordCode);
});

test("API-written cancellation records retain the exact strict format", async () => {
  const stateHome = await home();
  const runId = "run_valid_cancellation_records";
  const now = () => new Date("2026-07-15T00:00:00.000Z");
  await requestRunCancellation(stateHome, runId, "operator stop", now);
  await requestJobCancellation(stateHome, runId, "job_valid", "operator stop", now);

  assert.equal((await readRunCancellation(stateHome, runId))?.requested_at, now().toISOString());
  assert.deepEqual(
    (await readJobCancellations(stateHome, runId)).map((request) => request.job_id),
    ["job_valid"],
  );
});
