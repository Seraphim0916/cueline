import assert from "node:assert/strict";
import { claimCueLineCallerJob, startCueLineCallerJob } from "../../src/api.js";
import type { CueLineCallerWorkClaimProof } from "../../src/api-contracts.js";
import { CueLineError } from "../../src/core/errors.js";
import { RuntimeLease } from "../../src/state/runtime-lease.js";

const input = JSON.parse(process.argv[2]!) as {
  action: "claim" | "start" | "takeover"; home: string; runId: string; jobId: string;
  callerId: string; time: string; proof?: CueLineCallerWorkClaimProof;
  expectedOwnerId?: string; expectedHeartbeatAt?: string;
};
assert.ok(["claim", "start", "takeover"].includes(input.action));
const now = () => new Date(input.time);
const go = new Promise<void>((resolve) => process.once("message", () => resolve()));
process.send!("ready");
await go;
let heldLease: RuntimeLease | undefined;
let output: unknown;
try {
  if (input.action === "claim") {
    output = await claimCueLineCallerJob(input.runId, input.jobId, {
      home: input.home, now, callerId: input.callerId, ttlMs: 1_000,
    });
  } else if (input.action === "start") {
    output = await startCueLineCallerJob(input.runId, input.jobId, input.proof!, { home: input.home, now });
  } else {
    heldLease = await RuntimeLease.takeoverStale({ home: input.home, runId: input.runId, now,
      expectedOwnerId: input.expectedOwnerId!, expectedHeartbeatAt: input.expectedHeartbeatAt!, heartbeatIntervalMs: 60_000 });
    output = { outcome: "taken_over", ownerId: heldLease.ownerId, pid: process.pid };
  }
} catch (error) {
  if (!(error instanceof CueLineError)) throw error;
  output = { errorCode: error.code };
}
const finish = new Promise<void>((resolve) => process.once("message", () => resolve()));
process.send!({ output });
await finish;
await heldLease?.release();
process.disconnect!();
