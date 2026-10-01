import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { claimCueLineCallerJob, loadCueLineRunState, runCueLine, startCueLineCallerJob } from "../../src/api.js";
import type { CueLineCallerWorkClaimProof } from "../../src/api-contracts.js";
import { loadPersistedRunStore } from "../../src/core/persisted-run.js";
import { readEvents } from "../../src/state/event-log.js";
import { runPaths } from "../../src/state/paths.js";
import { RuntimeLease, readRuntimeLease, readRuntimeOwnerRetirementCutoffs } from "../../src/state/runtime-lease.js";

type Output = Record<string, string | number | boolean>;
type Input = { action: "claim" | "start" | "takeover"; home: string; runId: string; jobId: string;
  callerId: string; time: string; proof?: CueLineCallerWorkClaimProof;
  expectedOwnerId?: string; expectedHeartbeatAt?: string };

async function race(t: test.TestContext, inputs: Input[], inspect?: (outputs: Output[]) => Promise<void>): Promise<Output[]> {
  const workers = inputs.map((input) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../fixtures/caller-admission-race-child.js", import.meta.url)), JSON.stringify(input)], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr!.on("data", (data) => { stderr += String(data); });
    let readyResolve!: () => void;
    const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
    let resultResolve!: (output: Output) => void;
    let resultReject!: (error: unknown) => void;
    let reported = false;
    const result = new Promise<Output>((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
    child.on("message", (message) => {
      if (message === "ready") readyResolve();
      else if (typeof message === "object" && message !== null && "output" in message) {
        reported = true; resultResolve(message.output as Output);
      }
    });
    const done = new Promise<void>((resolve, reject) => {
      child.once("error", (error) => { readyResolve(); resultReject(error); reject(error); });
      child.once("close", (code, signal) => {
        readyResolve();
        if (!reported) resultReject(new Error(`Admission child exited before result: ${stderr}; ${signal}`));
        try { assert.equal(code, 0, `${stderr}; signal=${signal}`); resolve(); } catch (error) { reject(error); }
      });
    });
    // Teardown owns only this fixture process and waits for its actual exit.
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await done.catch(() => undefined); });
    return { child, ready, result, done };
  });
  let outputs: Output[] = [];
  let failed = true;
  try {
    await Promise.all([
    Promise.all(workers.map(({ done }) => done)),
    (async () => {
      // Attach result rejection handling before waiting for readiness.
      const results = Promise.all(workers.map(({ result }) => result));
      try {
        const [values] = await Promise.all([results, (async () => {
          await Promise.all(workers.map(({ ready }) => ready));
          for (const { child } of workers) if (child.connected) child.send("go");
        })()]);
        outputs = values;
        await inspect?.(values);
      } finally {
        for (const { child } of workers) if (child.connected) child.send("finish");
      }
    })(),
    ]);
    failed = false;
    return outputs;
  } finally {
    if (failed) for (const { child } of workers) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await Promise.allSettled(workers.map(({ done }) => done));
  }
}

async function fixture(runId: string) {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-admission-race-"));
  const workdir = path.join(home, "workspace");
  await mkdir(workdir);
  const time = "2026-07-22T00:00:00.000Z";
  const run = await runCueLine({ home, runId, now: () => new Date(time), request: "Fake concurrent admission", routingConfig: {
    version: 1, lanes: { default: { enabled: true, candidates: [{ id: "never-spawn", argv: ["never-spawn"], task_input: "stdin" }] } },
  }, browser: { async sendTurn(input) {
    return { text: `<CueLineControl>${JSON.stringify({ protocol: "cueline/0.1", run_id: input.runId,
      round: input.round, request_id: input.requestId, action: "dispatch",
      jobs: [{ job_key: "work", lane: "default", mode: "work", task: "Fake local work", workdir }],
    })}</CueLineControl>`, conversationUrl: "https://chatgpt.com/c/admission-fixture",
    model: { provider: "chatgpt", selectedLabel: "Pro", responseModelSlug: "gpt-5-6-pro", source: "composer_and_response" } };
  } } });
  return { home, workdir, time, jobId: Object.keys(run.state.jobs)[0]! };
}

for (const phase of ["pending", "expired_unstarted"] as const) {
  test(`independent processes admit one claimant for ${phase} work`, { timeout: 15_000 }, async (t) => {
    const runId = `run_process_claim_${phase}`;
    const { home, jobId, workdir, time } = await fixture(runId);
    try {
      let stale: CueLineCallerWorkClaimProof | undefined;
      let currentTime = time;
      if (phase === "expired_unstarted") {
        const old = await claimCueLineCallerJob(runId, jobId, { home, now: () => new Date(time), callerId: "old-owner", ttlMs: 1_000 });
        stale = { claimId: old.claimId, callerId: old.callerId, fencingToken: old.fencingToken };
        currentTime = "2026-07-22T00:00:02.000Z";
      }
      const inputs = ["a", "b"].map((callerId): Input => ({ action: "claim", home, runId, jobId, callerId, time: currentTime }));
      const outputs = await race(t, inputs);
      const winners = outputs.filter((output) => output.outcome === "claimed");
      const losers = outputs.filter((output) => output.errorCode !== undefined);
      assert.equal(winners.length, 1);
      assert.equal(losers.length, 1);
      assert.ok(["RUN_ALREADY_ACTIVE", "CALLER_WORK_ALREADY_CLAIMED"].includes(String(losers[0]!.errorCode)));
      const winner = winners[0]!;
      assert.equal(winner.workdir, workdir);
      assert.equal(winner.started, false);
      const proof = { claimId: String(winner.claimId), callerId: String(winner.callerId), fencingToken: Number(winner.fencingToken) };
      const now = () => new Date(currentTime);
      if (stale !== undefined) {
        assert.ok(proof.fencingToken > stale.fencingToken);
        await assert.rejects(startCueLineCallerJob(runId, jobId, stale, { home, now }), { code: "CALLER_WORK_CLAIM_MISMATCH" });
      }
      await assert.rejects(startCueLineCallerJob(runId, jobId, { ...proof, callerId: proof.callerId === "a" ? "b" : "a" }, { home, now }), { code: "CALLER_WORK_CLAIM_MISMATCH" });
      const starts = await race(t, inputs.map((input) => ({ ...input, action: "start", proof })));
      assert.equal(starts.filter((output) => output.outcome === "started").length, 1);
      const other = starts.find((output) => output.outcome !== "started")!;
      assert.ok(other.outcome === "already_started" || other.errorCode === "RUN_ALREADY_ACTIVE");
      const state = await loadCueLineRunState(runId, { home });
      assert.equal(state.jobs[jobId]?.status, "running");
      assert.equal(state.jobs[jobId]?.callerWork?.claim?.claimId, proof.claimId);
      const events = await readEvents(runPaths(home, runId).events);
      assert.equal(events.filter((event) => event.type === "caller_work_claimed").length, stale === undefined ? 1 : 2);
      assert.equal(events.filter((event) => event.type === "caller_work_claim_released").length, stale === undefined ? 0 : 1);
      assert.equal(events.filter((event) => event.type === "caller_work_started").length, 1);
      assert.equal(events.filter((event) => event.type === "job_registered").length, 1);
      assert.equal((await readRuntimeLease(home, runId, { now })).ownership, "missing");
    } finally { await rm(home, { recursive: true, force: true }); }
  });
}

test("independent exact stale takeovers admit one live runtime owner", { timeout: 15_000 }, async (t) => {
  const runId = "run_process_takeover";
  const { home, jobId, time } = await fixture(runId);
  const old = await RuntimeLease.claim({ home, runId, now: () => new Date(time), heartbeatIntervalMs: 60_000 });
  try {
    const store = await loadPersistedRunStore(home, runId);
    store.bindRuntimeOwner(old.ownerId);
    const before = await readEvents(runPaths(home, runId).events);
    const currentTime = "2026-07-22T00:01:00.000Z";
    const now = () => new Date(currentTime);
    const observed = await readRuntimeLease(home, runId, { now });
    const inputs = ["a", "b"].map((callerId): Input => ({ action: "takeover", home, runId, jobId, callerId,
      time: currentTime, expectedOwnerId: old.ownerId, expectedHeartbeatAt: observed.heartbeatAt! }));
    await race(t, inputs, async (outputs) => {
      const winners = outputs.filter((output) => output.outcome === "taken_over");
      assert.equal(winners.length, 1);
      assert.equal(outputs.filter((output) => output.errorCode === "RUNTIME_TAKEOVER_RACE").length, 1);
      const owner = await readRuntimeLease(home, runId, { now });
      assert.equal(owner.ownership, "active");
      assert.equal(owner.ownerId, winners[0]!.ownerId);
      assert.equal(owner.pid, String(winners[0]!.pid));
      await assert.rejects(store.append("notice", { message: "retired owner must not append" }), { code: "EVENT_RUNTIME_OWNER_RETIRED" });
      assert.deepEqual(await readEvents(runPaths(home, runId).events), before);
    });
    const cutoffs = await readRuntimeOwnerRetirementCutoffs(home, runId);
    assert.equal(cutoffs.get(old.ownerId), before.at(-1)!.sequence);
    await old.release();
    assert.equal((await readRuntimeLease(home, runId, { now })).ownership, "missing");
  } finally { await old.release(); await rm(home, { recursive: true, force: true }); }
});
