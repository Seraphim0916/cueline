import assert from "node:assert/strict";
import test from "node:test";

import { lintControllerCommandText } from "../../src/protocol/lint-command.js";

const expected = {
  runId: "run_lint",
  round: 3,
  requestId: "msg_lint",
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

test("accepts a valid command and returns its parsed action", () => {
  const result = lintControllerCommandText(
    envelope({ ...base("wait"), wait_ms: 5000 }),
    { expected },
  );

  assert.equal(result.valid, true);
  assert.equal(result.format, "envelope");
  assert.equal(result.command?.action, "wait");
  assert.deepEqual(result.issues, []);
});

test("reports legacy field and lane-runner mistakes in one pass", () => {
  const result = lintControllerCommandText(
    envelope({
      ...base("dispatch"),
      jobs: [
        {
          job_key: "audit",
          lane: "codex-default",
          mode: "advise",
          prompt: "Inspect the repository",
          runner_id: "codex-default",
        },
      ],
    }),
    {
      expected,
      routing: {
        lanes: ["default"],
        runnerLanes: { "codex-default": "default" },
      },
    },
  );

  assert.equal(result.valid, false);
  assert.deepEqual(
    result.issues
      .map((issue) => issue.code)
      .filter((code) =>
        ["LEGACY_PROMPT_FIELD", "LEGACY_RUNNER_ID_FIELD", "RUNNER_USED_AS_LANE"].includes(
          code,
        ),
      ),
    ["LEGACY_PROMPT_FIELD", "LEGACY_RUNNER_ID_FIELD", "RUNNER_USED_AS_LANE"],
  );
  assert.match(
    result.issues.find((issue) => issue.code === "RUNNER_USED_AS_LANE")?.suggestion ?? "",
    /lane.*default.*runner.*codex-default/i,
  );
});

test("does not mistake inherited object properties for configured runners", () => {
  const result = lintControllerCommandText(
    envelope({
      ...base("dispatch"),
      jobs: [
        {
          job_key: "audit",
          lane: "toString",
          mode: "advise",
          task: "Inspect",
        },
      ],
    }),
    {
      expected,
      routing: { lanes: ["default"], runnerLanes: {} },
    },
  );

  assert.equal(result.valid, false);
  assert.equal(result.issues[0]?.code, "ROUTE_LANE_UNKNOWN");
});

test("requires an absolute workdir for caller work", () => {
  const result = lintControllerCommandText(
    JSON.stringify({
      ...base("dispatch"),
      jobs: [
        {
          job_key: "mutate",
          lane: "default",
          mode: "work",
          task: "Edit files",
          workdir: "relative/path",
        },
      ],
    }),
    { expected },
  );

  assert.equal(result.format, "json");
  assert.equal(result.valid, false);
  assert.equal(result.issues[0]?.code, "WORKDIR_NOT_ABSOLUTE");
});

test("keeps exact pending identity authoritative", () => {
  const result = lintControllerCommandText(
    envelope({ ...base("wait"), request_id: "msg_other" }),
    { expected },
  );

  assert.equal(result.valid, false);
  assert.equal(result.issues.at(-1)?.code, "CONTROL_ID_MISMATCH");
});

test("rejects unknown top-level fields even though legacy validation ignores them", () => {
  const result = lintControllerCommandText(
    envelope({ ...base("wait"), made_up: true }),
    { expected },
  );

  assert.equal(result.valid, false);
  assert.equal(result.issues[0]?.code, "CONTROL_FIELD_UNKNOWN");
  assert.equal(result.issues[0]?.path, "$.made_up");
});

test("rejects a known field when it belongs to a different action", () => {
  const result = lintControllerCommandText(
    envelope({
      ...base("wait"),
      jobs: [{ job_key: "ignored", lane: "default", mode: "advise", task: "Ignored" }],
    }),
    { expected },
  );

  assert.equal(result.valid, false);
  assert.equal(result.issues[0]?.code, "CONTROL_FIELD_NOT_ALLOWED_FOR_ACTION");
  assert.equal(result.issues[0]?.path, "$.jobs");
});

test("invalid JSON returns bounded diagnostics without echoing the input", () => {
  const secret = "do-not-echo-this-sentinel";
  const result = lintControllerCommandText(
    `<CueLineControl>{oops:${secret}}</CueLineControl>`,
    { expected },
  );

  assert.equal(result.valid, false);
  assert.equal(result.issues[0]?.code, "CONTROL_JSON_INVALID");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});
