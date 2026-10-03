import assert from "node:assert/strict";
import fs from "node:fs";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import {
  claimCueLineCallerJob, loadCueLineRunState, runCueLine, startCueLineCallerJob,
} from "../../src/api.js";
import type { CueLineCallerWorkClaimResult } from "../../src/api-contracts.js";
import { JobStatusStore } from "../../src/jobs/status.js";
import { readEvents } from "../../src/state/event-log.js";
import { runPaths } from "../../src/state/paths.js";
import { readRuntimeLease } from "../../src/state/runtime-lease.js";

const [home, action, boundary] = process.argv.slice(2);
assert.ok(home && (action === "claim" || action === "start"));
assert.ok(["before_event", "after_event", "status_rename", "snapshot_rename"].includes(boundary!));
const runId = `run_storage_${action}_${boundary}`;
const now = () => new Date("2026-07-22T00:00:00.000Z");
const workdir = path.join(home, "workspace");
await mkdir(workdir);
let browserCalls = 0;
const run = await runCueLine({ home, runId, now, request: "Hermetic storage failure", routingConfig: {
  version: 1, lanes: { default: { enabled: true, candidates: [{ id: "never-spawn", argv: ["never-spawn"], task_input: "stdin" }] } },
}, browser: { async sendTurn(input) {
  browserCalls++;
  return { text: `<CueLineControl>${JSON.stringify({ protocol: "cueline/0.1", run_id: input.runId,
    round: input.round, request_id: input.requestId, action: "dispatch",
    jobs: [{ job_key: "work", lane: "default", mode: "work", task: "Fake local work", workdir }],
  })}</CueLineControl>`, conversationUrl: "https://chatgpt.com/c/storage-fixture",
  model: { provider: "chatgpt", selectedLabel: "Pro", responseModelSlug: "gpt-5-6-pro", source: "composer_and_response" } };
} } });
const jobId = Object.keys(run.state.jobs)[0]!;
const options = { home, now, callerId: "storage-owner", ttlMs: 1_000 };
let claim: CueLineCallerWorkClaimResult | undefined;
if (action === "start") claim = await claimCueLineCallerJob(runId, jobId, options);
const proof = () => { assert.ok(claim); return { claimId: claim.claimId, callerId: claim.callerId, fencingToken: claim.fencingToken }; };
const paths = runPaths(home, runId);
const statuses = new JobStatusStore(home);
const targetEvent = action === "claim" ? "caller_work_claimed" : "caller_work_started";
const code = boundary === "before_event" || boundary === "status_rename" ? "ENOSPC" : "EIO";
const injectedError = () => Object.assign(new Error(`Injected ${code} at ${boundary}`), { code });
const originalLink = fs.promises.link;
const originalRename = fs.promises.rename;
let injected = 0;
fs.promises.link = async (...args: Parameters<typeof fs.promises.link>) => {
  if (injected === 0 && (boundary === "before_event" || boundary === "after_event") &&
    path.dirname(String(args[1])) === `${paths.events}.segments`) {
    const event = JSON.parse(await readFile(args[0], "utf8")) as { type?: string };
    if (event.type === targetEvent) {
      injected++;
      if (boundary === "after_event") await originalLink(...args);
      throw injectedError();
    }
  }
  return originalLink(...args);
};
fs.promises.rename = async (...args: Parameters<typeof fs.promises.rename>) => {
  const target = String(args[1]);
  if (injected === 0 && ((boundary === "status_rename" && target === statuses.pathFor(jobId)) ||
    (boundary === "snapshot_rename" && target === paths.snapshot))) {
    injected++;
    throw injectedError();
  }
  return originalRename(...args);
};
syncBuiltinESMExports();
try {
  await assert.rejects(action === "claim"
    ? claimCueLineCallerJob(runId, jobId, options)
    : startCueLineCallerJob(runId, jobId, proof(), { home, now }), { code });
} finally {
  fs.promises.link = originalLink;
  fs.promises.rename = originalRename;
  syncBuiltinESMExports();
}
assert.equal(injected, 1);
assert.equal((await readRuntimeLease(home, runId, { now })).ownership, "missing");
const beforeRetry = await readEvents(paths.events);
const persistedTargets = beforeRetry.filter((event) => event.type === targetEvent);
assert.equal(persistedTargets.length, boundary === "before_event" ? 0 : 1);
const afterFailure = await loadCueLineRunState(runId, { home });
assert.equal(afterFailure.jobs[jobId]?.status, action === "start" && boundary !== "before_event" ? "running" : "pending");
const retained = afterFailure.jobs[jobId]?.callerWork?.claim;
if (retained !== null && retained !== undefined) {
  await assert.rejects(claimCueLineCallerJob(runId, jobId, { ...options, callerId: "foreign-owner" }), { code: "CALLER_WORK_ALREADY_CLAIMED" });
}
if (action === "claim") {
  claim = await claimCueLineCallerJob(runId, jobId, options);
  assert.equal(claim.outcome, boundary === "before_event" ? "claimed" : "already_claimed");
  if (retained !== null && retained !== undefined) {
    assert.equal(claim.claimId, retained.claimId);
    assert.equal(claim.fencingToken, retained.fencingToken);
  }
}
const started = await startCueLineCallerJob(runId, jobId, proof(), { home, now });
assert.equal(started.outcome, action === "start" && boundary !== "before_event" ? "already_started" : "started");
// No fake work is performed until an API actually returns valid authorization.
const ledger = path.join(home, "fake-execution.jsonl");
await appendFile(ledger, `${JSON.stringify({ claimId: claim!.claimId })}\n`);
assert.equal((await startCueLineCallerJob(runId, jobId, proof(), { home, now })).outcome, "already_started");
const afterRetry = await readEvents(paths.events);
assert.equal(afterRetry.filter((event) => event.type === "caller_work_claimed").length, 1);
assert.equal(afterRetry.filter((event) => event.type === "caller_work_started").length, 1);
if (persistedTargets.length === 1) assert.deepEqual(afterRetry.filter((event) => event.type === targetEvent), persistedTargets);
assert.equal((await loadCueLineRunState(runId, { home })).jobs[jobId]?.status, "running");
assert.equal((await readFile(ledger, "utf8")).trim().split("\n").length, 1);
assert.equal((await readRuntimeLease(home, runId, { now })).ownership, "missing");
assert.equal(browserCalls, 1);
assert.deepEqual((await readdir(home, { recursive: true })).filter((name) => name.endsWith(".tmp")), []);
console.log(JSON.stringify({ action, boundary, code, injected, claimEvents: 1, startEvents: 1, fakeExecutions: 1,
  persistedStatus: (await statuses.read(jobId))?.status }));
