import assert from "node:assert/strict";
import test from "node:test";

import { CueLineError } from "../../src/core/errors.js";
import { buildCueLineRunTimeline } from "../../src/observation/run-timeline.js";
import type { RunEvent } from "../../src/state/event-log.js";

const secret = "TIMELINE-SECRET-NEVER-LEAKS";

function event(sequence: number, type: string, payload: unknown): RunEvent {
  return {
    sequence,
    timestamp: `2026-07-15T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    type,
    payload,
    runtime_owner_id: "owner_runtime_secret",
  };
}

test("timeline projects every event category to allowlisted attributes and never leaks raw payload", () => {
  const events = [
    event(1, "controller_submission_succeeded", {
      round: 2,
      request_id: "msg_a",
      response_model_slug: "Pro",
      stage: "submitted",
      submission_state: "submitted",
      prompt: secret,
    }),
    event(2, "controller_response_received", { round: 2, request_id: "msg_a", response_text: secret }),
    event(3, "controller_command_accepted", {
      command: { action: "dispatch", request_id: "msg_a", jobs: [{}, {}], task: secret },
    }),
    event(4, "controller_conversation_archive_started", {}),
    event(5, "controller_conversation_archived", {}),
    event(6, "controller_conversation_archive_ambiguous", { code: "ARCHIVE_AMBIGUOUS" }),
    event(7, "controller_conversation_archive_failed", { code: "ARCHIVE_FAILED" }),
    event(8, "controller_conversation_archive_preflight_failed", { code: "ARCHIVE_PREFLIGHT" }),
    event(9, "job_status", {
      job_id: "job_x",
      status: "succeeded",
      runner_id: "codex-default",
      pid: 4242,
      selected_model_label: "gpt-5.5",
      error: secret,
      output: secret,
    }),
    event(10, "run_failed", { code: "RUN_FAILED_X", error: secret }),
    event(11, "run_completed", {}),
    event(12, "run_blocked", { reason: secret }),
    event(13, "run_cancelled", { reason: secret }),
  ];

  const timeline = buildCueLineRunTimeline("run_timeline", events, "/tmp/cueline-home");

  assert.deepEqual(
    timeline.entries.map((entry) => entry.type),
    events.map((entry) => entry.type),
  );

  const submission = timeline.entries[0]?.attributes;
  assert.equal(submission?.model, "Pro");
  assert.equal(submission?.stage, "submitted");
  assert.equal(submission?.submissionState, "submitted");
  assert.equal(submission?.requestId, "msg_a");
  assert.equal(submission?.round, 2);

  const command = timeline.entries[2]?.attributes;
  assert.equal(command?.action, "dispatch");
  assert.equal(command?.jobCount, 2);

  assert.equal(timeline.entries[5]?.attributes.code, "ARCHIVE_AMBIGUOUS");

  const jobStatus = timeline.entries[8]?.attributes;
  assert.equal(jobStatus?.status, "succeeded");
  assert.equal(jobStatus?.runner, "codex-default");
  assert.equal(jobStatus?.pid, 4242);
  assert.equal(jobStatus?.model, "gpt-5.5");

  assert.equal(timeline.entries[9]?.attributes.code, "RUN_FAILED_X");
  assert.match(timeline.entries[10]?.summary ?? "", /completed/i);
  assert.match(timeline.entries[12]?.summary ?? "", /cancel/i);

  // Sanitization: neither raw payload content nor the runtime owner id can leak.
  const serialized = JSON.stringify(timeline);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.doesNotMatch(serialized, /owner_runtime_secret/);
});

test("timeline rejects an out-of-range afterSequence or limit", () => {
  const invalid = [{ afterSequence: -1 }, { afterSequence: 1.5 }, { limit: 0 }, { limit: 1_001 }];
  for (const options of invalid) {
    assert.throws(
      () => buildCueLineRunTimeline("run_timeline", [], "/tmp/cueline-home", options),
      (error: unknown) =>
        error instanceof CueLineError && error.code === "RUN_TIMELINE_OPTIONS_INVALID",
    );
  }
});
