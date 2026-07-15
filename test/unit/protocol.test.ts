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

test("rejects prompt in a dispatch job with an explicit task field correction", () => {
  const command = {
    ...base("dispatch"),
    jobs: [
      {
        job_key: "review",
        lane: "triage",
        mode: "advise",
        prompt: "one",
      },
    ],
  };
  assert.throws(
    () => parseControllerCommand(envelope(command), expected),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "CONTROL_JOB_FIELD_UNKNOWN" &&
      /prompt.*task/.test(error.message),
  );
});

test("rejects unknown top-level command fields instead of silently dropping them", () => {
  assert.throws(
    () =>
      parseControllerCommand(
        envelope({ ...base("wait"), operator_hint: "silently ignored before" }),
        expected,
      ),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "CONTROL_COMMAND_FIELD_UNKNOWN" &&
      /operator_hint/.test(error.message),
  );
});

test("rejects known fields that do not belong to the selected action", () => {
  const cases = [
    { value: { ...base("dispatch"), jobs: [], wait_ms: 1 }, field: "wait_ms" },
    { value: { ...base("wait"), jobs: [] }, field: "jobs" },
    { value: { ...base("inspect"), wait_ms: 1 }, field: "wait_ms" },
    {
      value: { ...base("complete"), final_delivery_text: "done", reason: "extra" },
      field: "reason",
    },
    { value: { ...base("blocked"), reason: "blocked", job_ids: ["job_1"] }, field: "job_ids" },
  ];

  for (const { value, field } of cases) {
    assert.throws(
      () => parseControllerCommand(envelope(value), expected),
      (error: unknown) =>
        error instanceof CueLineError &&
        error.code === "CONTROL_COMMAND_FIELD_INVALID_FOR_ACTION" &&
        error.message.includes(field) &&
        error.message.includes(String((value as Record<string, unknown>).action)),
    );
  }
});

test("keeps the exact allowed optional fields for wait, inspect, and blocked", () => {
  assert.deepEqual(
    parseControllerCommand(
      envelope({ ...base("wait"), job_ids: ["job_1"], wait_ms: 5_000 }),
      expected,
    ),
    { ...base("wait"), job_ids: ["job_1"], wait_ms: 5_000 },
  );
  assert.deepEqual(
    parseControllerCommand(envelope({ ...base("inspect"), job_ids: ["job_1"] }), expected),
    { ...base("inspect"), job_ids: ["job_1"] },
  );
  assert.deepEqual(
    parseControllerCommand(
      envelope({ ...base("blocked"), reason: "why", final_delivery_text: "stop" }),
      expected,
    ),
    { ...base("blocked"), reason: "why", final_delivery_text: "stop" },
  );
});

test("rejects empty, duplicate, or malformed job_ids instead of accepting a no-op inspect", () => {
  for (const jobIds of [[], ["job_1", "job_1"], ["   "], ["../job_1"]]) {
    assert.throws(
      () =>
        parseControllerCommand(
          envelope({ ...base("inspect"), job_ids: jobIds }),
          expected,
        ),
      hasCode("CONTROL_COMMAND_INVALID"),
    );
  }
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

test("parses a single-job inspect evidence offset", () => {
  const evidenceHash = "a".repeat(64);
  const parsed = parseControllerCommand(
    envelope({
      ...base("inspect"),
      job_ids: ["job_abc"],
      evidence_offset: 12_345,
      evidence_hash: evidenceHash,
    }),
    expected,
  );
  assert.deepEqual(parsed, {
    ...base("inspect"),
    job_ids: ["job_abc"],
    evidence_offset: 12_345,
    evidence_hash: evidenceHash,
  });
});

test("rejects unsafe or ambiguous inspect evidence offsets", () => {
  for (const command of [
    { ...base("inspect"), evidence_offset: 1, evidence_hash: "a".repeat(64) },
    {
      ...base("inspect"),
      job_ids: ["job_a", "job_b"],
      evidence_offset: 1,
      evidence_hash: "a".repeat(64),
    },
    {
      ...base("inspect"),
      job_ids: ["job_a"],
      evidence_offset: -1,
      evidence_hash: "a".repeat(64),
    },
    {
      ...base("inspect"),
      job_ids: ["job_a"],
      evidence_offset: 1.5,
      evidence_hash: "a".repeat(64),
    },
    {
      ...base("inspect"),
      job_ids: ["job_a"],
      evidence_offset: 1_000_000_001,
      evidence_hash: "a".repeat(64),
    },
    { ...base("inspect"), job_ids: ["job_a"], evidence_offset: 1 },
    { ...base("inspect"), job_ids: ["job_a"], evidence_hash: "a".repeat(64) },
    {
      ...base("inspect"),
      job_ids: ["job_a"],
      evidence_offset: 1,
      evidence_hash: "not-a-sha256",
    },
  ]) {
    assert.throws(
      () => parseControllerCommand(envelope(command), expected),
      hasCode("CONTROL_COMMAND_INVALID"),
    );
  }
  assert.throws(
    () =>
      parseControllerCommand(
        envelope({
          ...base("wait"),
          job_ids: ["job_a"],
          evidence_offset: 1,
          evidence_hash: "a".repeat(64),
        }),
        expected,
      ),
    hasCode("CONTROL_COMMAND_FIELD_INVALID_FOR_ACTION"),
  );
});
