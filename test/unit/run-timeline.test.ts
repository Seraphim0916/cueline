import assert from "node:assert/strict";
import test from "node:test";

import { buildCueLineRunTimeline } from "../../src/observation/run-timeline.js";
import type { RunEvent } from "../../src/state/event-log.js";

const secret = "TIMELINE-SECRET-MUST-NOT-LEAK";

function event(sequence: number, type: string, payload: unknown): RunEvent {
  return {
    sequence,
    timestamp: `2026-07-15T00:00:0${sequence}.000Z`,
    type,
    payload,
    runtime_owner_id: "owner_runtime_123",
  };
}

test("summarizes only allowlisted metadata and never raw payload content", () => {
  const timeline = buildCueLineRunTimeline(
    "run_timeline",
    [
      event(1, "run_created", { request: secret }),
      event(2, "controller_turn_requested", {
        round: 1,
        request_id: "msg_timeline",
        prompt: secret,
        prompt_hash: "prompt-hash",
      }),
      event(3, "job_registered", {
        job: {
          jobId: "job_timeline",
          jobKey: "audit",
          spec: { task: secret, lane: "default", mode: "advise" },
        },
      }),
      event(4, "job_status", {
        job_id: "job_timeline",
        status: "failed",
        error: secret,
        output: secret,
      }),
    ],
    "/tmp/cueline-home",
  );

  assert.deepEqual(
    timeline.entries.map((entry) => entry.type),
    ["run_created", "controller_turn_requested", "job_registered", "job_status"],
  );
  assert.equal(timeline.entries[1]?.attributes.requestId, "msg_timeline");
  assert.equal(timeline.entries[2]?.attributes.jobId, "job_timeline");
  assert.equal(timeline.entries[3]?.attributes.status, "failed");
  assert.doesNotMatch(JSON.stringify(timeline), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(timeline), /owner_runtime_123/);
  assert.match(timeline.entries[0]?.ownerFingerprint ?? "", /^[a-f0-9]{12}$/);
});

test("paginates with an exclusive durable sequence cursor", () => {
  const timeline = buildCueLineRunTimeline(
    "run_timeline",
    [
      event(1, "run_created", {}),
      event(2, "controller_turn_requested", { request_id: "msg_2", round: 1 }),
      event(3, "controller_submission_succeeded", { request_id: "msg_2" }),
      event(4, "controller_response_received", { request_id: "msg_2" }),
    ],
    "/tmp/cueline-home",
    { afterSequence: 1, limit: 2 },
  );

  assert.deepEqual(timeline.entries.map((entry) => entry.sequence), [2, 3]);
  assert.equal(timeline.hasMore, true);
  assert.equal(timeline.nextAfterSequence, 3);
  assert.equal(timeline.totalEvents, 4);
});

test("rejects an impossible cursor instead of returning a misleading empty page", () => {
  assert.throws(
    () =>
      buildCueLineRunTimeline(
        "run_timeline",
        [event(1, "run_created", {})],
        "/tmp/cueline-home",
        { afterSequence: 2 },
      ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "RUN_TIMELINE_CURSOR_AHEAD",
  );
});

test("sanitizes hostile event type and timestamp metadata", () => {
  const timeline = buildCueLineRunTimeline(
    "run_timeline",
    [
      {
        sequence: 1,
        timestamp: secret,
        type: `run_created_${secret}`,
        payload: {},
      },
    ],
    "/tmp/cueline-home",
  );

  assert.equal(timeline.entries[0]?.type, "unknown_event");
  assert.equal(timeline.entries[0]?.timestamp, null);
  assert.doesNotMatch(JSON.stringify(timeline), new RegExp(secret));
});

test("does not trust an unknown event type merely because it looks syntactically safe", () => {
  const timeline = buildCueLineRunTimeline(
    "run_timeline",
    [event(1, "lowercasesecret", {})],
    "/tmp/cueline-home",
  );

  assert.equal(timeline.entries[0]?.type, "unknown_event");
  assert.doesNotMatch(JSON.stringify(timeline), /lowercasesecret/);
});

test("does not echo syntactically safe text through typed metadata slots", () => {
  const timeline = buildCueLineRunTimeline(
    "run_timeline",
    [
      event(1, "run_failed", {
        request_id: "lowercasesecret",
        code: "lowercasesecret",
        stage: "lowercasesecret",
        selected_model_label: "lowercasesecret",
      }),
    ],
    "/tmp/cueline-home",
  );

  assert.deepEqual(timeline.entries[0]?.attributes, {});
  assert.doesNotMatch(JSON.stringify(timeline), /lowercasesecret/);
});
