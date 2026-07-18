import assert from "node:assert/strict";
import test from "node:test";

import {
  isLegacyJobStatusSource,
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
