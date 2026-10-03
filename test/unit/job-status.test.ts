import assert from "node:assert/strict";
import test from "node:test";

import {
  isLegacyJobStatusSource,
  parseJobStatus,
  jobStatusRecordIsLegacy,
} from "../../src/jobs/status.js";

const currentResult = {
  status: "succeeded",
  exitCode: 0,
  stdout: "",
  stderr: "",
  output: "ok",
  emptyOutput: false,
  timedOut: false,
  cancelled: false,
  ambiguousSideEffects: false,
  retryable: false,
  startedAt: "2026-07-18T00:00:00.000Z",
  finishedAt: "2026-07-18T00:00:01.000Z",
};

function legacyResult() {
  const { cancelled: _cancelled, ...withoutCancelled } = currentResult;
  return withoutCancelled;
}

test("jobStatusRecordIsLegacy flags a result object missing the cancelled field", () => {
  assert.equal(jobStatusRecordIsLegacy({ result: legacyResult() }), true);
});

test("jobStatusRecordIsLegacy does not flag a result that already carries cancelled", () => {
  assert.equal(jobStatusRecordIsLegacy({ result: currentResult }), false);
});

test("jobStatusRecordIsLegacy does not flag a status without a result", () => {
  assert.equal(jobStatusRecordIsLegacy({ status: "running" }), false);
  assert.equal(jobStatusRecordIsLegacy({ result: null }), false);
});

test("jobStatusRecordIsLegacy does not flag non-objects", () => {
  assert.equal(jobStatusRecordIsLegacy(null), false);
  assert.equal(jobStatusRecordIsLegacy("legacy"), false);
  assert.equal(jobStatusRecordIsLegacy(42), false);
});

test("isLegacyJobStatusSource detects pre-0.1.7 evidence from raw JSON", () => {
  assert.equal(
    isLegacyJobStatusSource(JSON.stringify({ result: legacyResult() })),
    true,
  );
});

test("isLegacyJobStatusSource returns false for current evidence and unparseable input", () => {
  assert.equal(
    isLegacyJobStatusSource(JSON.stringify({ result: currentResult })),
    false,
  );
  assert.equal(isLegacyJobStatusSource("{not json"), false);
  assert.equal(isLegacyJobStatusSource(""), false);
});

for (const status of ["succeeded", "failed", "cancelled", "timed_out", "ambiguous"] as const) {
  test(`persisted ${status} evidence enforces the timeout flag contract`, () => {
    const source = (timedOut: boolean) => JSON.stringify({
      jobId: "job_timeout_contract", execution: "foreground", status,
      startedAt: currentResult.startedAt, finishedAt: currentResult.finishedAt,
      result: { ...currentResult, status, timedOut, cancelled: status === "cancelled",
        ambiguousSideEffects: status === "ambiguous" },
    });
    if (status === "ambiguous") {
      assert.equal(parseJobStatus(source(true)).result?.timedOut, true);
      assert.equal(parseJobStatus(source(false)).result?.timedOut, false);
    } else {
      const expected = status === "timed_out";
      assert.equal(parseJobStatus(source(expected)).result?.timedOut, expected);
      assert.throws(() => parseJobStatus(source(!expected)), { code: "JOB_STATUS_INVALID" });
    }
  });
}

test("ambiguous timeout evidence retains cancellation cause but requires boolean flags", () => {
  const record = {
    jobId: "job_ambiguous_timeout", execution: "foreground", status: "ambiguous",
    startedAt: currentResult.startedAt,
    result: { ...currentResult, status: "ambiguous", timedOut: true, cancelled: true,
      ambiguousSideEffects: true },
  };
  assert.equal(parseJobStatus(JSON.stringify(record)).result?.cancelled, true);
  for (const timedOut of ["true", 1, null]) {
    assert.throws(() => parseJobStatus(JSON.stringify({
      ...record, result: { ...record.result, timedOut },
    })), { code: "JOB_STATUS_INVALID" });
  }
});
