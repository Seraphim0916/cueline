import assert from "node:assert/strict";
import test from "node:test";

import {
  initialRunState,
  reduceRunState,
} from "../../src/core/state-machine.js";
import type { RunEvent } from "../../src/state/event-log.js";

function event(type: string, payload: unknown): RunEvent {
  return {
    sequence: 1,
    timestamp: "2026-07-26T00:00:00.000Z",
    type,
    payload,
  };
}

test("legacy run_created without max_rounds keeps the historical finite contract", () => {
  const state = reduceRunState(
    initialRunState("run_legacy_round_contract", ""),
    event("run_created", {
      request: "Replay an existing run",
      executor: "caller",
    }),
  );

  assert.equal(state.maxRounds, 12);
  assert.equal(state.maxStagnantRounds, 12);
  assert.equal(state.stagnantRounds, 0);
  assert.equal(state.lastProgressFingerprint, null);
});

test("new run_created can persist an unlimited round contract", () => {
  const state = reduceRunState(
    initialRunState("run_unlimited_round_contract", ""),
    event("run_created", {
      request: "Replay a new unlimited run",
      executor: "caller",
      max_rounds: null,
      max_stagnant_rounds: 12,
    }),
  );

  assert.equal(state.maxRounds, null);
  assert.equal(state.maxStagnantRounds, 12);
});
