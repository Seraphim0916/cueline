import assert from "node:assert/strict";
import test from "node:test";

import { CueLineError } from "../../src/core/errors.js";
import { parseControllerCommand } from "../../src/protocol/parse-command.js";

const expected = {
  runId: "run_alpha",
  round: 2,
  requestId: "msg_round_2",
};

function envelope(value: unknown): string {
  return `<CueLineControl>\n${JSON.stringify(value)}\n</CueLineControl>`;
}

function base(action: string): Record<string, unknown> {
  return {
    protocol: "cueline/0.1",
    run_id: expected.runId,
    round: expected.round,
    request_id: expected.requestId,
    action,
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof CueLineError && error.code === code;
}

test("rejects text without a complete control envelope", () => {
  assert.throws(
    () => parseControllerCommand("plain prose", expected),
    hasCode("CONTROL_ENVELOPE_MISSING"),
  );
});

test("rejects invalid JSON in the last complete envelope", () => {
  assert.throws(
    () => parseControllerCommand("<CueLineControl>{oops}</CueLineControl>", expected),
    hasCode("CONTROL_JSON_INVALID"),
  );
});

test("rejects stale run, round, and request identities", () => {
  const command = { ...base("wait"), round: 1 };
  assert.throws(
    () => parseControllerCommand(envelope(command), expected),
    hasCode("CONTROL_ID_MISMATCH"),
  );
});

test("rejects duplicate job keys", () => {
  const command = {
    ...base("dispatch"),
    jobs: [
      { job_key: "review", lane: "triage", mode: "advise", task: "one" },
      { job_key: "review", lane: "triage", mode: "advise", task: "two" },
    ],
  };
  assert.throws(
    () => parseControllerCommand(envelope(command), expected),
    hasCode("CONTROL_DUPLICATE_JOB_KEY"),
  );
});

test("rejects unknown job modes", () => {
  const command = {
    ...base("dispatch"),
    jobs: [{ job_key: "review", lane: "triage", mode: "review", task: "one" }],
  };
  assert.throws(
    () => parseControllerCommand(envelope(command), expected),
    hasCode("CONTROL_MODE_INVALID"),
  );
});

test("rejects runner_id with an explicit runner field correction", () => {
  const command = {
    ...base("dispatch"),
    jobs: [
      {
        job_key: "review",
        lane: "triage",
        mode: "advise",
        task: "one",
        runner_id: "codex-default",
      },
    ],
  };
  assert.throws(
    () => parseControllerCommand(envelope(command), expected),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "CONTROL_JOB_FIELD_UNKNOWN" &&
      /runner_id.*runner/.test(error.message),
  );
});

test("parses only the last complete valid dispatch envelope", () => {
  const stale = envelope({ ...base("wait"), round: 1 });
  const valid = envelope({
    ...base("dispatch"),
    jobs: [
      {
        job_key: "review",
        lane: "hard-judgment",
        mode: "advise",
        task: "Review the architecture",
        required: true,
        timeout_ms: 30_000,
      },
    ],
  });

  const parsed = parseControllerCommand(`${stale}\n${valid}\n<CueLineControl>{`, expected);
  assert.equal(parsed.action, "dispatch");
  if (parsed.action !== "dispatch") {
    assert.fail("expected dispatch command");
  }
  assert.equal(parsed.jobs[0]?.job_key, "review");
  assert.equal(parsed.jobs[0]?.required, true);
});

test("parses a complete command with final delivery text", () => {
  const parsed = parseControllerCommand(
    envelope({ ...base("complete"), final_delivery_text: "CUELINE_OK" }),
    expected,
  );
  assert.deepEqual(parsed, {
    ...base("complete"),
    final_delivery_text: "CUELINE_OK",
  });
});

test("rejects a control envelope above the protocol size budget", () => {
  const command = { ...base("blocked"), reason: "x".repeat(131_072) };
  assert.throws(
    () => parseControllerCommand(envelope(command), expected),
    hasCode("CONTROL_ENVELOPE_TOO_LARGE"),
  );
});

test("rejects a dispatch that exceeds the per-command job limit", () => {
  const command = {
    ...base("dispatch"),
    jobs: Array.from({ length: 65 }, (_, index) => ({
      job_key: `review_${index}`,
      lane: "triage",
      mode: "advise",
      task: `Review item ${index}`,
    })),
  };
  assert.throws(
    () => parseControllerCommand(envelope(command), expected),
    hasCode("CONTROL_DISPATCH_JOBS_LIMIT_EXCEEDED"),
  );
});

test("rejects wait and inspect commands above the job reference limit", () => {
  const jobIds = Array.from({ length: 257 }, (_, index) => `job_${index}`);
  for (const action of ["wait", "inspect"]) {
    assert.throws(
      () => parseControllerCommand(envelope({ ...base(action), job_ids: jobIds }), expected),
      hasCode("CONTROL_JOB_IDS_LIMIT_EXCEEDED"),
    );
  }
});

test("accepts controller commands exactly at the documented resource limits", () => {
  const jobs = Array.from({ length: 64 }, (_, index) => ({
    job_key: `review_${index}`,
    lane: "triage",
    mode: "advise",
    task: `Review item ${index}`,
  }));
  const dispatch = parseControllerCommand(
    envelope({ ...base("dispatch"), jobs }),
    expected,
  );
  assert.equal(dispatch.action, "dispatch");
  if (dispatch.action === "dispatch") assert.equal(dispatch.jobs.length, 64);

  const jobIds = Array.from({ length: 256 }, (_, index) => `job_${index}`);
  const inspect = parseControllerCommand(
    envelope({ ...base("inspect"), job_ids: jobIds }),
    expected,
  );
  assert.equal(inspect.action, "inspect");
  if (inspect.action === "inspect") assert.equal(inspect.job_ids?.length, 256);
});
