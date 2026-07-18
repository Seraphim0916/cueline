import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { claimCueLineCallerJob } from "../../src/api.js";
import { CueLineError } from "../../src/core/errors.js";

// claimCueLineCallerJob validates callerId and ttlMs before it opens the run
// store, so pointing it at an absent run drives both request-input gates in
// isolation: a malformed claim must be refused before it can mutate any durable
// run state (the symmetric counterpart to caller job result validation).
async function claimAgainstAbsentRun(options: {
  callerId: string;
  ttlMs?: number;
}): Promise<unknown> {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-caller-claim-"));
  return claimCueLineCallerJob("run_absent", "job_absent", {
    ...options,
    home,
    environment: { CUELINE_HOME: home },
  });
}

function rejectsWith(
  options: { callerId: string; ttlMs?: number },
  code: string,
): Promise<void> {
  return assert.rejects(
    claimAgainstAbsentRun(options),
    (error: unknown) => error instanceof CueLineError && error.code === code,
  );
}

test("caller claim rejects a blank, oversized, or control-character callerId", async () => {
  const control = (code: number): string => `caller${String.fromCharCode(code)}id`;
  for (const callerId of [
    "",
    "   ",
    "a".repeat(257),
    control(0), // NUL
    control(9), // tab
    control(10), // newline
    control(127), // DEL
  ]) {
    await rejectsWith({ callerId }, "CALLER_ID_INVALID");
  }
});

test("caller claim rejects a ttlMs that is not an integer within [1000, 86400000]", async () => {
  // 1.5 / NaN trip the safe-integer check; 500 is below MIN; 86_400_001 is above MAX.
  for (const ttlMs of [1.5, Number.NaN, 500, 86_400_001]) {
    await rejectsWith({ callerId: "caller-ok", ttlMs }, "CALLER_WORK_CLAIM_TTL_INVALID");
  }
});

test("caller claim lets a well-formed request past both input gates", async () => {
  // A valid callerId with the default ttl clears both gates; the only remaining
  // failure is the absent run, proving neither gate rejected a good request.
  for (const options of [{ callerId: "caller-ok" }, { callerId: "caller-ok", ttlMs: 1_000 }]) {
    await assert.rejects(
      claimAgainstAbsentRun(options),
      (error: unknown) =>
        error instanceof CueLineError &&
        error.code !== "CALLER_ID_INVALID" &&
        error.code !== "CALLER_WORK_CLAIM_TTL_INVALID",
    );
  }
});
