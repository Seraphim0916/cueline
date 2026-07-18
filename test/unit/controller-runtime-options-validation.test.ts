import assert from "node:assert/strict";
import test from "node:test";

import { validateControllerRuntimeOptions } from "../../src/core/controller-loop.js";
import { CueLineError } from "../../src/core/errors.js";

// validateControllerRuntimeOptions is the pure gate every run's resource limits
// pass through before a controller run is created. Lock each rejection branch
// to its distinct error code so a malformed limit can never silently produce a
// run with a broken bound.
function rejectsWith(options: unknown, code: string): void {
  assert.throws(
    () => validateControllerRuntimeOptions(options as never),
    (error: unknown) => error instanceof CueLineError && error.code === code,
  );
}

test("rejects a non-boolean archive policy", () => {
  for (const archiveControllerConversationOnComplete of ["yes", 1, null]) {
    rejectsWith(
      { archiveControllerConversationOnComplete },
      "CONTROLLER_CONVERSATION_ARCHIVE_POLICY_INVALID",
    );
  }
});

test("rejects a non-positive-integer maxRounds", () => {
  for (const maxRounds of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    rejectsWith({ maxRounds }, "MAX_ROUNDS_INVALID");
  }
});

test("rejects a non-positive-integer maxJobEvidenceChars", () => {
  for (const maxJobEvidenceChars of [0, -5, 2.5, Number.NaN]) {
    rejectsWith({ maxJobEvidenceChars }, "MAX_JOB_EVIDENCE_CHARS_INVALID");
  }
});

test("rejects a negative or non-integer maxRepairAttempts", () => {
  for (const maxRepairAttempts of [-1, 1.5, Number.NaN]) {
    rejectsWith({ maxRepairAttempts }, "MAX_REPAIR_ATTEMPTS_INVALID");
  }
});

test("rejects a non-positive-integer maxConcurrency", () => {
  for (const maxConcurrency of [0, -2, 1.5, Number.NaN]) {
    rejectsWith({ maxConcurrency }, "MAX_CONCURRENCY_INVALID");
  }
});

test("rejects invalid timer delays with their own distinct codes", () => {
  rejectsWith({ runTimeoutMs: -1 }, "RUN_TIMEOUT_INVALID");
  rejectsWith({ cancellationPollIntervalMs: 1.5 }, "CANCELLATION_POLL_INTERVAL_INVALID");
  rejectsWith({ runtimeHeartbeatIntervalMs: Number.NaN }, "RUNTIME_HEARTBEAT_INTERVAL_INVALID");
});

test("rejects a malformed laneConcurrency record or limit", () => {
  for (const laneConcurrency of [null, 3, "x", [1, 2]]) {
    rejectsWith({ laneConcurrency }, "LANE_CONCURRENCY_INVALID");
  }
  for (const limit of [0, -1, 1.5, Number.NaN, "2"]) {
    rejectsWith({ laneConcurrency: { advise: limit } }, "LANE_CONCURRENCY_INVALID");
  }
});

test("normalizes valid input to durable defaults and freezes lane limits", () => {
  const normalized = validateControllerRuntimeOptions({});
  assert.equal(normalized.maxRepairAttempts, 2);
  assert.equal(typeof normalized.maxRounds, "number");
  assert.equal(normalized.maxRounds >= 1, true);
  assert.equal(typeof normalized.maxJobEvidenceChars, "number");
  assert.equal(normalized.laneConcurrency, undefined);

  const withLanes = validateControllerRuntimeOptions({
    laneConcurrency: { advise: 3, background: 1 },
  });
  assert.deepEqual({ ...withLanes.laneConcurrency }, { advise: 3, background: 1 });
  assert.equal(Object.isFrozen(withLanes.laneConcurrency), true);
});
