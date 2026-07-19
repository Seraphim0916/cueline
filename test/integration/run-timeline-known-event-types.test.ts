import assert from "node:assert/strict";
import test from "node:test";

import { buildCueLineRunTimeline } from "../../src/observation/run-timeline.js";
import type { RunEvent } from "../../src/state/event-log.js";

function event(sequence: number, type: string, payload: Record<string, unknown> = {}): RunEvent {
  return {
    sequence,
    timestamp: `2026-07-15T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    type,
    payload,
  };
}

test("buildCueLineRunTimeline renders not-sent-recovery events instead of the generic unknown-event", () => {
  // controller_turn_not_sent_confirmed and controller_turn_retry_conflict are
  // live, state-mutating recovery events (they drive state.notSentRecovery ->
  // retry / manual_review). They were missing from the timeline's known-event
  // allowlist, so the timeline and support bundle mislabeled them as
  // "unknown_event" with "Unknown event metadata omitted." at exactly the
  // reconciliation moments an operator needs explained.
  const timeline = buildCueLineRunTimeline(
    "run_recovery_events",
    [
      event(1, "run_created", { request: "diagnose me" }),
      event(2, "controller_turn_not_sent_confirmed", { request_id: "msg_notsent", round: 5 }),
      event(3, "controller_turn_retry_conflict", {
        code: "CONTROLLER_NOT_SENT_RESPONSE_CONFLICT",
      }),
    ],
    "/tmp/cueline-home",
  );

  const bySequence = new Map(timeline.entries.map((entry) => [entry.sequence, entry]));

  const notSent = bySequence.get(2)!;
  assert.equal(notSent.type, "controller_turn_not_sent_confirmed");
  assert.equal(notSent.category, "controller");
  assert.equal(notSent.summary, "Controller turn confirmed not sent; ready to retry.");

  const conflict = bySequence.get(3)!;
  assert.equal(conflict.type, "controller_turn_retry_conflict");
  assert.equal(conflict.category, "controller");
  assert.equal(
    conflict.summary,
    "Controller turn retry conflict detected: CONTROLLER_NOT_SENT_RESPONSE_CONFLICT.",
  );
  assert.equal(conflict.attributes.code, "CONTROLLER_NOT_SENT_RESPONSE_CONFLICT");

  // Regression guard: neither may collapse back to the generic unknown-event.
  for (const entry of [notSent, conflict]) {
    assert.notEqual(entry.type, "unknown_event");
    assert.notEqual(entry.summary, "Unknown event metadata omitted.");
  }
});
