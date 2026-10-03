import assert from "node:assert/strict";
import { appendFile, mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  cancelCueLineJob,
  cancelCueLineRun,
  claimCueLineCallerJob,
  continueCueLineRun,
  runCueLine,
  heartbeatCueLineCallerJob,
  recordCueLineCallerJobProgress,
  startCueLineCallerJob,
  submitCueLineCallerJobResult,
} from "../../src/api.js";
import type { CueLineCallerWorkClaimProof } from "../../src/api-contracts.js";
import { requireCueLineCallerJobReview } from "../../src/api-caller-work.js";
import type { BrowserAdapter } from "../../src/browser/browser-adapter.js";
import { CueLineError } from "../../src/core/errors.js";
import { RunStore } from "../../src/state/store.js";
import { JobStatusStore, type JobStatus } from "../../src/jobs/status.js";

const [mode, home, runId] = process.argv.slice(2);
assert.ok(home && runId);
assert.ok(["before-terminal", "after-terminal", "cancel-run", "cancel-job", "retry-result", "continue",
  "after-job-result-event", "after-work-result-event", "after-job-status-event",
  "attempt-claim", "attempt-start", "attempt-heartbeat", "attempt-progress", "attempt-review", "crash-expiry"].includes(mode!));
const metadataPath = path.join(home, "result-fixture.json");
const crashMode = mode === "before-terminal" || mode === "after-terminal" || mode?.startsWith("after-") === true;
let current = new Date("2026-07-22T00:00:00.000Z");
const now = () => current;

interface Metadata {
  workId: string;
  adviceId: string;
  proof: CueLineCallerWorkClaimProof;
  expiresAt: string;
}

const routingConfig = {
  version: 1 as const,
  lanes: { default: { enabled: true, candidates: [
    { id: "never-spawn", argv: ["never-spawn"], task_input: "stdin" as const },
  ] } },
};

const browser: BrowserAdapter = {
  async sendTurn(input) {
    await appendFile(path.join(home!, "browser-actions.jsonl"), `${JSON.stringify({ requestId: input.requestId })}\n`);
    assert.equal(crashMode, true, "recovery must not contact the controller");
    return {
      text: `<CueLineControl>${JSON.stringify({
        protocol: "cueline/0.1", run_id: input.runId, round: input.round, request_id: input.requestId,
        action: "dispatch",
        jobs: [
          { job_key: "fake_work", lane: "default", mode: "work",
            task: "Perform one fake fixture action", workdir: path.join(home!, "workspace") },
          { job_key: "pending_advice", lane: "default", mode: "advise",
            task: "Leave this fake advice pending" },
        ],
      })}</CueLineControl>`,
      conversationUrl: "https://chatgpt.com/c/hermetic-result-crash",
      model: { provider: "chatgpt", selectedLabel: "Pro", responseModelSlug: "gpt-5-6-pro", source: "composer_and_response" },
    };
  },
};

async function crashAtBoundary(): Promise<never> {
  const marker = await open(path.join(home!, "crash-checkpoint.json"), "w", 0o600);
  try {
    await marker.writeFile(JSON.stringify({ phase: mode, pid: process.pid }));
    await marker.sync();
  } finally {
    await marker.close();
  }
  // Abruptly kill only this fixture process: no catch/finally can clean up
  // runtime ownership or finish the interrupted terminal transition.
  process.kill(process.pid, "SIGKILL");
  return new Promise<never>(() => {});
}

try {
  if (crashMode) {
    await mkdir(path.join(home, "workspace"));
    const result = await runCueLine({ home, runId, now, routingConfig, browser, request: "Test result durability at cancellation" });
    assert.equal(result.status, "awaiting_caller_work");
    const jobs = Object.values(result.state.jobs);
    const work = jobs.find((job) => job.jobKey === "fake_work")!;
    const advice = jobs.find((job) => job.jobKey === "pending_advice")!;
    const claim = await claimCueLineCallerJob(runId, work.jobId, { home, now, callerId: "fake-caller", ttlMs: 1_000 });
    const proof = { claimId: claim.claimId, callerId: claim.callerId, fencingToken: claim.fencingToken };
    await startCueLineCallerJob(runId, work.jobId, proof, { home, now });
    await writeFile(metadataPath, JSON.stringify({ workId: work.jobId, adviceId: advice.jobId, proof, expiresAt: claim.expiresAt } satisfies Metadata));
    await appendFile(path.join(home, "fake-execution.jsonl"), `${JSON.stringify({ jobId: work.jobId, pid: process.pid })}\n`);
    current = new Date("2026-07-22T00:00:00.500Z");
    const writeStatus = JobStatusStore.prototype.write;
    JobStatusStore.prototype.write = async function(this: JobStatusStore, status: JobStatus) {
      const target = status.runId === runId && status.jobId === work.jobId && status.status === "succeeded";
      if (target && mode === "before-terminal") await crashAtBoundary();
      await writeStatus.call(this, status);
      if (target && mode === "after-terminal") await crashAtBoundary();
    };
    const eventBoundary = mode === "after-job-result-event" ? "caller_job_result_submitted"
      : mode === "after-work-result-event" ? "caller_work_result_submitted"
      : mode === "after-job-status-event" ? "job_status" : undefined;
    if (eventBoundary !== undefined) {
      const append = RunStore.prototype.append;
      RunStore.prototype.append = async function(type, payload, options) {
        const event = await append.call(this, type, payload, options);
        if (this.runId === runId && type === eventBoundary) await crashAtBoundary();
        return event;
      };
    }
    await submitCueLineCallerJobResult(runId, work.jobId, {
      status: "succeeded", stdout: "COMMITTED_FAKE_SUCCESS",
      startedAt: "2026-07-22T00:00:00.000Z", finishedAt: current.toISOString(),
    }, { home, now, claim: proof });
    throw new Error("Result submission missed the crash boundary");
  }

  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Metadata;
  current = new Date(mode === "attempt-review" ? "2026-07-22T00:00:00.750Z" : "2026-07-22T00:00:02.000Z");
  assert.equal(current.getTime() > Date.parse(metadata.expiresAt), mode !== "attempt-review");
  let output: unknown;
  if (mode === "crash-expiry") {
    const writeStatus = JobStatusStore.prototype.write;
    JobStatusStore.prototype.write = async function(this: JobStatusStore, status: JobStatus) {
      await writeStatus.call(this, status);
      if (status.runId === runId && status.jobId === metadata.workId && status.status === "ambiguous") {
        await crashAtBoundary();
      }
    };
    await continueCueLineRun({ home, runId, now, routingConfig, browser });
    throw new Error("Expiry reconciliation missed the crash boundary");
  } else if (mode?.startsWith("attempt-")) {
    try {
      switch (mode) {
        case "attempt-claim":
          output = await claimCueLineCallerJob(runId, metadata.workId, { home, now, callerId: metadata.proof.callerId });
          break;
        case "attempt-start":
          output = await startCueLineCallerJob(runId, metadata.workId, metadata.proof, { home, now });
          break;
        case "attempt-heartbeat":
          output = await heartbeatCueLineCallerJob(runId, metadata.workId, metadata.proof, { home, now });
          break;
        case "attempt-progress":
          output = await recordCueLineCallerJobProgress(runId, metadata.workId, metadata.proof,
            { kind: "tool_completed", evidenceHash: "a".repeat(64) }, { home, now });
          break;
        case "attempt-review":
          output = { reviewRequested: await requireCueLineCallerJobReview(runId, metadata.workId, metadata.proof,
            { reasonCode: "progress_stalled", reason: "Fake delayed review after completed work", limitMs: 100 }, { home, now }) };
          break;
      }
    } catch (error) {
      if (!(error instanceof CueLineError)) throw error;
      output = { errorCode: error.code };
    }
  } else if (mode === "cancel-run") {
    output = await cancelCueLineRun(runId, { home, now });
  } else if (mode === "cancel-job") {
    output = await cancelCueLineJob(runId, metadata.workId, { home, now });
  } else if (mode === "retry-result") {
    try {
      output = await submitCueLineCallerJobResult(runId, metadata.workId, {
        status: "succeeded", stdout: "RETRY_MUST_NOT_OVERWRITE",
      }, { home, now, claim: metadata.proof });
    } catch (error) {
      if (!(error instanceof CueLineError)) throw error;
      output = { errorCode: error.code };
    }
  } else {
    const result = await continueCueLineRun({ home, runId, now, routingConfig, browser });
    output = { status: result.status };
  }
  console.log(JSON.stringify(output));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
