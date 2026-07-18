import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { submitCueLineCallerJobResult } from "../../src/api.js";
import { CueLineError } from "../../src/core/errors.js";

// submitCueLineCallerJobResult validates the result body (assertCallerJobResultInput)
// as its very first step, before it touches any durable run state. Pointing it at
// an absent run therefore exercises the input gate in isolation: a malformed caller
// result must be rejected before it could ever poison a run's authoritative log.
async function submitToAbsentRun(input: unknown): Promise<unknown> {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-caller-result-"));
  return submitCueLineCallerJobResult("run_absent", "job_absent", input as never, {
    home,
    environment: { CUELINE_HOME: home },
  });
}

function rejectsWith(
  input: unknown,
  code: string,
  messagePattern?: RegExp,
): Promise<void> {
  return assert.rejects(
    submitToAbsentRun(input),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === code &&
      (messagePattern === undefined || messagePattern.test(error.message)),
  );
}

test("caller job result rejects a body that is not a plain object", async () => {
  for (const body of [null, "succeeded", 42, true, ["succeeded"]]) {
    await rejectsWith(body, "CALLER_JOB_RESULT_INVALID", /must be an object/);
  }
});

test("caller job result rejects an unsupported terminal status", async () => {
  for (const status of [undefined, "running", "done", "SUCCEEDED", 1, null]) {
    await rejectsWith({ status }, "CALLER_JOB_STATUS_INVALID");
  }
});

test("caller job result accepts every supported terminal status past the input gate", async () => {
  // A supported status must clear the status check; the only remaining failure is
  // the absent run, proving the gate did not reject a well-formed status.
  for (const status of ["succeeded", "failed", "timed_out", "cancelled", "ambiguous"]) {
    await assert.rejects(
      submitToAbsentRun({ status }),
      (error: unknown) =>
        error instanceof CueLineError &&
        error.code !== "CALLER_JOB_RESULT_INVALID" &&
        error.code !== "CALLER_JOB_STATUS_INVALID",
    );
  }
});

test("caller job result rejects a non-string optional field", async () => {
  for (const field of ["stdout", "stderr", "output", "error", "startedAt", "finishedAt"]) {
    await rejectsWith(
      { status: "succeeded", [field]: 123 },
      "CALLER_JOB_RESULT_INVALID",
      new RegExp(field),
    );
  }
});

test("caller job result rejects an unparseable startedAt/finishedAt timestamp", async () => {
  for (const field of ["startedAt", "finishedAt"]) {
    await rejectsWith(
      { status: "succeeded", [field]: "not-a-timestamp" },
      "CALLER_JOB_RESULT_INVALID",
      /timestamp/,
    );
  }
});

test("caller job result rejects finishedAt preceding startedAt", async () => {
  await rejectsWith(
    {
      status: "succeeded",
      startedAt: "2026-07-19T02:00:00.000Z",
      finishedAt: "2026-07-19T01:00:00.000Z",
    },
    "CALLER_JOB_RESULT_INVALID",
    /cannot precede/,
  );
});

test("caller job result rejects an exitCode that is not a safe integer or null", async () => {
  for (const exitCode of [1.5, Number.NaN, "0", {}, Number.MAX_SAFE_INTEGER + 1]) {
    await rejectsWith({ status: "failed", exitCode }, "CALLER_JOB_RESULT_INVALID", /exitCode/);
  }
});

test("caller job result lets a fully well-formed body past the input gate", async () => {
  await assert.rejects(
    submitToAbsentRun({
      status: "succeeded",
      stdout: "ok",
      stderr: "",
      exitCode: 0,
      startedAt: "2026-07-19T01:00:00.000Z",
      finishedAt: "2026-07-19T02:00:00.000Z",
    }),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code !== "CALLER_JOB_RESULT_INVALID" &&
      error.code !== "CALLER_JOB_STATUS_INVALID",
  );
});
