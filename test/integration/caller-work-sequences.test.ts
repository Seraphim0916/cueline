import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cancelCueLineJob, claimCueLineCallerJob, heartbeatCueLineCallerJob,
  loadCueLineRunState, recordCueLineCallerJobProgress, releaseCueLineCallerJob,
  runCueLine, startCueLineCallerJob, submitCueLineCallerJobResult,
} from "../../src/api.js";
import { reconcileExpiredCallerWorkClaims } from "../../src/api-caller-work.js";
import { loadPersistedRunStore } from "../../src/core/persisted-run.js";
import { JobStatusStore } from "../../src/jobs/status.js";
import { readEvents } from "../../src/state/event-log.js";
import { runPaths } from "../../src/state/paths.js";
import { RuntimeLease, readRuntimeLease } from "../../src/state/runtime-lease.js";
import { readAuthoritativeRunEvents } from "../../src/state/store.js";

// Eight finite schedules, not an unbounded fuzzer. Each preserves the documented
// phase prerequisites while permuting independent operations and terminal cause.
const seeds = [1, 2, 3, 4, 17, 42, 73, 101];
function random(seed: number) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
}
function shuffle<T>(values: readonly T[], next: () => number): T[] {
  const output = [...values];
  for (let i = output.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [output[i], output[j]] = [output[j]!, output[i]!];
  }
  return output;
}

for (const seed of seeds) {
  test(`bounded caller lifecycle sequence seed=${seed}`, { timeout: 20_000 }, async (t) => {
    const next = random(seed);
    const trace: string[] = [];
    const home = await mkdtemp(path.join(tmpdir(), `cueline-sequence-${seed}-`));
    t.after(() => rm(home, { recursive: true, force: true }));
    const workdir = path.join(home, "workspace");
    await mkdir(workdir);
    const runId = `run_sequence_${seed}`;
    let clock = Date.parse("2026-07-22T00:00:00.000Z");
    const now = () => new Date(clock);
    let browserCalls = 0;
    const run = await runCueLine({ home, runId, now, request: "Hermetic lifecycle model", routingConfig: {
      version: 1, lanes: { default: { enabled: true, candidates: [
        { id: "never-spawn", argv: ["never-spawn"], task_input: "stdin" },
      ] } },
    }, browser: { async sendTurn(input) {
      browserCalls++;
      return { text: `<CueLineControl>${JSON.stringify({
        protocol: "cueline/0.1", run_id: input.runId, round: input.round, request_id: input.requestId,
        action: "dispatch", jobs: [{ job_key: "work", lane: "default", mode: "work", task: "Fake work", workdir }],
      })}</CueLineControl>`, conversationUrl: "https://chatgpt.com/c/sequence-fixture",
      model: { provider: "chatgpt", selectedLabel: "Pro", responseModelSlug: "gpt-5-6-pro", source: "composer_and_response" } };
    } } });
    const jobId = Object.values(run.state.jobs)[0]!.jobId;
    const statuses = new JobStatusStore(home);
    let claim = await claimCueLineCallerJob(runId, jobId, { home, now, callerId: "owner-a", ttlMs: 1_000 });
    const proof = () => ({ claimId: claim.claimId, callerId: claim.callerId, fencingToken: claim.fencingToken });
    const wrongProof = () => ({ ...proof(), fencingToken: claim.fencingToken + 1 });
    let expectedStatus = "pending";
    let terminalBytes: string[] | undefined;
    const progress = new Map<string, string>();

    async function invariants() {
      const state = await loadCueLineRunState(runId, { home });
      assert.equal(state.jobs[jobId]?.status, expectedStatus);
      assert.equal(browserCalls, 1);
      assert.equal((await readRuntimeLease(home, runId, { now })).ownership, "missing");
      const events = await readAuthoritativeRunEvents(home, runId);
      assert.ok(events.filter((event) => event.type === "caller_work_started").length <= 1);
      if (expectedStatus === "pending" || expectedStatus === "running") {
        assert.equal(events.filter((event) => event.type === "caller_work_result_submission_started").length, 0);
      }
      if (expectedStatus === "succeeded") {
        const intents = events.filter((event) => event.type === "caller_work_result_submission_started");
        assert.equal(intents.length, 1);
        assert.deepEqual(intents[0]?.payload, { job_id: jobId, status: "succeeded", claim_id: claim.claimId,
          caller_id: claim.callerId, fencing_token: claim.fencingToken });
      }
      if (terminalBytes !== undefined) {
        assert.deepEqual(await Promise.all([readFile(statuses.pathFor(jobId), "utf8"), readFile(statuses.terminalPathFor(jobId), "utf8")]), terminalBytes);
      }
    }
    async function step(label: string, action: () => Promise<unknown>) {
      trace.push(label);
      try { await action(); await invariants(); }
      catch (error) { throw new Error(`seed=${seed}; trace=${trace.join(" -> ")}`, { cause: error }); }
    }
    async function retireOwner() {
      const old = await RuntimeLease.claim({ home, runId, now: () => new Date(clock - 60_000), heartbeatIntervalMs: 60_000 });
      let winner: RuntimeLease | undefined;
      try {
        const store = await loadPersistedRunStore(home, runId);
        store.bindRuntimeOwner(old.ownerId);
        const observed = await readRuntimeLease(home, runId, { now });
        winner = await RuntimeLease.takeoverStale({ home, runId, now,
          expectedOwnerId: old.ownerId, expectedHeartbeatAt: observed.heartbeatAt! });
        const before = await readEvents(runPaths(home, runId).events);
        await assert.rejects(store.append("caller_work_result_submission_started", {
          job_id: jobId, status: "succeeded", claim_id: claim.claimId, caller_id: claim.callerId, fencing_token: claim.fencingToken,
        }), { code: "EVENT_RUNTIME_OWNER_RETIRED" });
        assert.deepEqual(await readEvents(runPaths(home, runId).events), before);
      } finally { await old.release(); await winner?.release(); }
    }
    for (const action of shuffle(["heartbeat", "reclaim", "expire_reclaim", "foreign_claim", "wrong_start", "retire"] as const, next)) {
      await step(`pending:${action}`, async () => {
        if (action === "heartbeat") {
          clock += 100;
          assert.equal((await heartbeatCueLineCallerJob(runId, jobId, proof(), { home, now })).outcome, "heartbeat_recorded");
        } else if (action === "reclaim" || action === "expire_reclaim") {
          const stale = proof();
          if (action === "expire_reclaim") clock += 1_001;
          else await releaseCueLineCallerJob(runId, jobId, stale, { home, now });
          claim = await claimCueLineCallerJob(runId, jobId, { home, now, callerId: "owner-a", ttlMs: 1_000 });
          assert.ok(claim.fencingToken > stale.fencingToken);
          await assert.rejects(startCueLineCallerJob(runId, jobId, stale, { home, now }), { code: "CALLER_WORK_CLAIM_MISMATCH" });
        } else if (action === "foreign_claim") {
          await assert.rejects(claimCueLineCallerJob(runId, jobId, { home, now, callerId: "owner-b" }), { code: "CALLER_WORK_ALREADY_CLAIMED" });
        } else if (action === "wrong_start") {
          await assert.rejects(startCueLineCallerJob(runId, jobId, wrongProof(), { home, now }), { code: "CALLER_WORK_CLAIM_MISMATCH" });
        } else await retireOwner();
      });
    }
    await step("start", async () => {
      assert.equal((await startCueLineCallerJob(runId, jobId, proof(), { home, now })).outcome, "started");
      expectedStatus = "running";
    });
    for (const action of shuffle(["progress_a", "progress_a", "progress_b", "heartbeat", "start_again", "wrong_result", "retire"] as const, next)) {
      await step(`running:${action}`, async () => {
        clock += 50;
        if (action.startsWith("progress_")) {
          const hash = action.endsWith("a") ? "a".repeat(64) : "b".repeat(64);
          const before = await loadCueLineRunState(runId, { home });
          const result = await recordCueLineCallerJobProgress(runId, jobId, proof(), { kind: "tool_completed", evidenceHash: hash }, { home, now });
          assert.equal(result.outcome, progress.has(hash) ? "progress_already_recorded" : "progress_recorded");
          if (progress.has(hash)) {
            const after = await loadCueLineRunState(runId, { home });
            assert.deepEqual(after.jobs[jobId]?.callerWork?.claim, before.jobs[jobId]?.callerWork?.claim);
            assert.equal(result.progressAt, progress.get(hash));
          } else progress.set(hash, result.progressAt!);
        } else if (action === "heartbeat") {
          await heartbeatCueLineCallerJob(runId, jobId, proof(), { home, now });
        } else if (action === "start_again") {
          assert.equal((await startCueLineCallerJob(runId, jobId, proof(), { home, now })).outcome, "already_started");
        } else if (action === "wrong_result") {
          await assert.rejects(submitCueLineCallerJobResult(runId, jobId, { status: "succeeded" }, { home, now, claim: wrongProof() }), { code: "CALLER_WORK_CLAIM_MISMATCH" });
        } else await retireOwner();
      });
    }
    const ending = ["success", "timeout", "cancel", "expiry"][seed % 4]!;
    await step(`terminal:${ending}`, async () => {
      if (ending === "expiry") {
        clock += 1_001;
        assert.equal(await reconcileExpiredCallerWorkClaims(runId, { home, now }), 1);
        expectedStatus = "ambiguous";
      } else if (ending === "cancel") {
        await cancelCueLineJob(runId, jobId, { home, now });
        expectedStatus = "ambiguous";
      } else {
        await submitCueLineCallerJobResult(runId, jobId, { status: ending === "success" ? "succeeded" : "timed_out", stdout: `seed-${seed}` }, { home, now, claim: proof() });
        expectedStatus = ending === "success" ? "succeeded" : "ambiguous";
      }
      assert.equal((await statuses.read(jobId))?.status, expectedStatus);
      terminalBytes = await Promise.all([readFile(statuses.pathFor(jobId), "utf8"), readFile(statuses.terminalPathFor(jobId), "utf8")]);
    });
    for (const action of shuffle(["claim", "start", "heartbeat", "progress", "result", "release", "retire"] as const, next)) {
      await step(`terminal:${action}`, async () => {
        const before = await readEvents(runPaths(home, runId).events);
        if (action === "claim") await assert.rejects(claimCueLineCallerJob(runId, jobId, { home, now, callerId: "owner-a" }), { code: "CALLER_WORK_NOT_CLAIMABLE" });
        else if (action === "start") await assert.rejects(startCueLineCallerJob(runId, jobId, proof(), { home, now }), { code: "CALLER_WORK_NOT_STARTABLE" });
        else if (action === "heartbeat") await assert.rejects(heartbeatCueLineCallerJob(runId, jobId, proof(), { home, now }), { code: "CALLER_WORK_NOT_ACTIVE" });
        else if (action === "progress") await assert.rejects(recordCueLineCallerJobProgress(runId, jobId, proof(), { kind: "tool_completed", evidenceHash: "c".repeat(64) }, { home, now }), { code: "CALLER_WORK_NOT_STARTED" });
        else if (action === "result") assert.equal((await submitCueLineCallerJobResult(runId, jobId, { status: "succeeded", stdout: "must not overwrite" }, { home, now, claim: proof() })).outcome, "already_terminal");
        else if (action === "release") await assert.rejects(releaseCueLineCallerJob(runId, jobId, proof(), { home, now }), {
          code: "CALLER_WORK_NOT_ACTIVE",
        });
        else await retireOwner();
        assert.deepEqual(await readEvents(runPaths(home, runId).events), before);
      });
    }
  });
}
