import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadCueLineRunState } from "../../src/api.js";
import { JobStatusStore } from "../../src/jobs/status.js";
import { readEvents } from "../../src/state/event-log.js";
import { runPaths } from "../../src/state/paths.js";
import { readRuntimeLease } from "../../src/state/runtime-lease.js";

function runChild(home: string, runId: string, mode: string) {
  const environment: NodeJS.ProcessEnv = { ...process.env, HOME: home, CUELINE_HOME: home };
  delete environment.CUELINE_DEPTH;
  const child = spawnSync(process.execPath, [
    fileURLToPath(new URL("../fixtures/caller-result-crash-child.js", import.meta.url)), mode, home, runId,
  ], { env: environment, encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" });
  assert.equal(child.error, undefined, child.stderr);
  if (mode === "before-terminal" || mode === "after-terminal" || mode === "crash-expiry" || mode.startsWith("after-")) {
    assert.equal(child.signal, "SIGKILL", child.stderr);
    assert.equal(child.status, null, child.stderr);
    return { pid: child.pid, output: {} as Record<string, unknown> };
  }
  assert.equal(child.status, 0, child.stderr);
  return { pid: child.pid, output: JSON.parse(child.stdout.trim()) as Record<string, unknown> };
}

for (const boundary of ["before-terminal", "after-terminal"] as const) {
  for (const scope of ["run", "job"] as const) {
    test(`${scope} cancellation after executor death ${boundary} preserves first durable outcome`, async (t) => {
      if (process.platform === "win32") {
        t.skip("The fixture requires POSIX SIGKILL semantics");
        return;
      }
      const home = await mkdtemp(path.join(tmpdir(), "cueline-result-cancel-crash-"));
      const runId = `run_result_cancel_${scope}_${boundary.replaceAll("-", "_")}`;
      const crashed = runChild(home, runId, boundary);
      const checkpoint = JSON.parse(await readFile(path.join(home, "crash-checkpoint.json"), "utf8"));
      assert.deepEqual(checkpoint, { phase: boundary, pid: crashed.pid });
      const owner = await readRuntimeLease(home, runId);
      assert.equal(owner.pid, String(crashed.pid));
      assert.ok(owner.ownerId);
      const metadata = JSON.parse(await readFile(path.join(home, "result-fixture.json"), "utf8")) as {
        workId: string; adviceId: string; expiresAt: string;
      };
      const { workId, adviceId } = metadata;
      const before = await loadCueLineRunState(runId, { home });
      assert.equal(before.jobs[workId]?.status, "running");
      assert.equal(before.jobs[adviceId]?.status, "pending");
      const eventsBefore = await readEvents(runPaths(home, runId).events);
      assert.equal(eventsBefore.filter((event) => event.type === "caller_work_result_submission_started").length, 1);
      for (const type of ["caller_job_result_submitted", "caller_work_result_submitted", "run_cancelled"]) {
        assert.equal(eventsBefore.some((event) => event.type === type), false, type);
      }
      const statuses = new JobStatusStore(home);
      const committed = boundary === "after-terminal";
      assert.equal((await statuses.read(workId))?.status, committed ? "succeeded" : "running");
      const preCrashFiles = committed ? await Promise.all([
        readFile(statuses.pathFor(workId), "utf8"),
        readFile(statuses.terminalPathFor(workId), "utf8"),
      ]) : undefined;
      if (!committed) await assert.rejects(readFile(statuses.terminalPathFor(workId)), { code: "ENOENT" });

      const cancelled = runChild(home, runId, `cancel-${scope}`);
      assert.equal(cancelled.output.outcome, scope === "run" ? "cancelled" : committed ? "already_terminal" : "ambiguous");
      const afterCancellation = await loadCueLineRunState(runId, { home });
      assert.equal(afterCancellation.jobs[workId]?.status, committed ? "succeeded" : "ambiguous");
      assert.equal(afterCancellation.jobs[adviceId]?.status, scope === "run" ? "cancelled" : "pending");
      assert.equal(afterCancellation.jobs[workId]?.output, committed ? "COMMITTED_FAKE_SUCCESS" : null);
      const durableFiles = await Promise.all([
        readFile(statuses.pathFor(workId), "utf8"),
        readFile(statuses.terminalPathFor(workId), "utf8"),
      ]);
      if (committed) assert.deepEqual(durableFiles, preCrashFiles);
      const eventsAfterCancellation = await readEvents(runPaths(home, runId).events);

      const retried = runChild(home, runId, "retry-result");
      if (committed) assert.equal(retried.output.outcome, "already_terminal");
      else assert.equal(retried.output.errorCode, "CALLER_JOB_RESULT_CONFLICT");
      assert.equal(runChild(home, runId, `cancel-${scope}`).output.outcome, "already_terminal");
      assert.deepEqual(await readEvents(runPaths(home, runId).events), eventsAfterCancellation);
      assert.deepEqual(await Promise.all([
        readFile(statuses.pathFor(workId), "utf8"),
        readFile(statuses.terminalPathFor(workId), "utf8"),
      ]), durableFiles);
      assert.equal(runChild(home, runId, "continue").output.status, scope === "run" ? "cancelled" : "awaiting_caller");

      const finalState = await loadCueLineRunState(runId, { home });
      assert.equal(finalState.jobs[workId]?.status, committed ? "succeeded" : "ambiguous");
      const events = await readEvents(runPaths(home, runId).events);
      assert.equal(events.filter((event) => event.type === "caller_work_started").length, 1);
      assert.equal(events.filter((event) => event.type === "job_registered").length, 2);
      assert.equal(events.filter((event) => event.type === "controller_command_accepted").length, 1);
      assert.equal(events.filter((event) => event.type === "runtime_dead_owner_retired" &&
        (event.payload as { owner_id: string }).owner_id === owner.ownerId).length, 1);
      assert.equal(events.filter((event) => event.type === "job_status" &&
        (event.payload as { job_id: string }).job_id === workId).length, 1);
      assert.equal(events.some((event) => event.type === "caller_work_result_submitted"), false);
      assert.equal((await readFile(path.join(home, "fake-execution.jsonl"), "utf8")).trim().split("\n").length, 1);
      assert.equal((await readFile(path.join(home, "browser-actions.jsonl"), "utf8")).trim().split("\n").length, 1);
      assert.equal((await readRuntimeLease(home, runId)).ownership, "missing");
    });
  }
}

for (const storage of ["anchor", "unanchored"] as const) {
  for (const [field, value] of [["lane", "foreign-lane"], ["mode", "advise"], ["execution", "background"]] as const) {
    test(`result retry rejects ${storage} terminal evidence with conflicting ${field}`, async (t) => {
      if (process.platform === "win32") { t.skip("The fixture requires POSIX SIGKILL semantics"); return; }
      const home = await mkdtemp(path.join(tmpdir(), "cueline-result-anchor-conflict-"));
      const runId = `run_result_${storage}_${field}`;
      runChild(home, runId, "after-terminal");
      const { workId } = JSON.parse(await readFile(path.join(home, "result-fixture.json"), "utf8")) as { workId: string };
      const statuses = new JobStatusStore(home);
      const anchor = JSON.parse(await readFile(statuses.terminalPathFor(workId), "utf8"));
      anchor[field] = value;
      const conflictingEvidence = JSON.stringify(anchor);
      const evidencePath = storage === "anchor" ? statuses.terminalPathFor(workId) : statuses.pathFor(workId);
      if (storage === "unanchored") await unlink(statuses.terminalPathFor(workId));
      await writeFile(evidencePath, conflictingEvidence);
      assert.equal(runChild(home, runId, "retry-result").output.errorCode, "CALLER_JOB_RESULT_CONFLICT");
      const state = await loadCueLineRunState(runId, { home });
      assert.equal(state.jobs[workId]?.status, "running");
      assert.equal(state.jobs[workId]?.output, null);
      assert.equal(await readFile(evidencePath, "utf8"), conflictingEvidence);
      if (storage === "unanchored") await assert.rejects(readFile(statuses.terminalPathFor(workId)), { code: "ENOENT" });
      const events = await readEvents(runPaths(home, runId).events);
      assert.equal(events.some((event) => ["caller_work_result_submitted", "caller_job_result_submitted", "job_status", "caller_work_became_ambiguous"].includes(event.type)), false);
      assert.equal((await readFile(path.join(home, "fake-execution.jsonl"), "utf8")).trim().split("\n").length, 1);
    });
  }
}

for (const boundary of ["after-job-result-event", "after-work-result-event", "after-job-status-event"] as const) {
  test(`exact result retry preserves authority after executor death ${boundary}`, async (t) => {
    if (process.platform === "win32") { t.skip("The fixture requires POSIX SIGKILL semantics"); return; }
    const home = await mkdtemp(path.join(tmpdir(), "cueline-result-event-crash-"));
    const runId = `run_result_event_${boundary.replaceAll("-", "_")}`;
    const crashed = runChild(home, runId, boundary);
    assert.deepEqual(JSON.parse(await readFile(path.join(home, "crash-checkpoint.json"), "utf8")),
      { phase: boundary, pid: crashed.pid });
    const { workId, proof } = JSON.parse(await readFile(path.join(home, "result-fixture.json"), "utf8")) as {
      workId: string; proof: { claimId: string; callerId: string; fencingToken: number };
    };
    const before = await readEvents(runPaths(home, runId).events);
    const intent = before.filter((event) => event.type === "caller_work_result_submission_started");
    assert.equal(intent.length, 1);
    assert.deepEqual(intent[0]?.payload, { job_id: workId, status: "succeeded", claim_id: proof.claimId,
      caller_id: proof.callerId, fencing_token: proof.fencingToken });
    assert.equal(before.filter((event) => event.type === "caller_job_result_submitted").length, 1);
    assert.equal(before.filter((event) => event.type === "caller_work_result_submitted").length,
      boundary === "after-job-result-event" ? 0 : 1);
    assert.equal(before.filter((event) => event.type === "job_status").length,
      boundary === "after-job-status-event" ? 1 : 0);
    assert.equal((await loadCueLineRunState(runId, { home })).jobs[workId]?.status,
      boundary === "after-job-status-event" ? "succeeded" : "running");
    const statuses = new JobStatusStore(home);
    const files = await Promise.all([readFile(statuses.pathFor(workId), "utf8"), readFile(statuses.terminalPathFor(workId), "utf8")]);
    assert.equal(runChild(home, runId, "retry-result").output.outcome,
      boundary === "after-job-status-event" ? "already_terminal" : "submitted");
    const afterRetry = await readEvents(runPaths(home, runId).events);
    assert.equal(runChild(home, runId, "retry-result").output.outcome, "already_terminal");
    assert.deepEqual(await readEvents(runPaths(home, runId).events), afterRetry);
    assert.deepEqual(afterRetry.filter((event) => event.type === "caller_work_result_submission_started"), intent);
    assert.equal(afterRetry.filter((event) => event.type === "caller_job_result_submitted").length, 1);
    // The claim-specific submitted marker is redundant audit detail. A crash
    // may omit it; exact intent plus terminal evidence still proves authority.
    assert.equal(afterRetry.filter((event) => event.type === "caller_work_result_submitted").length,
      boundary === "after-job-result-event" ? 0 : 1);
    assert.equal(afterRetry.filter((event) => event.type === "job_status" &&
      (event.payload as { job_id: string }).job_id === workId).length, 1);
    assert.equal(afterRetry.filter((event) => event.type === "caller_work_started").length, 1);
    const state = await loadCueLineRunState(runId, { home });
    assert.equal(state.jobs[workId]?.status, "succeeded");
    assert.equal(state.jobs[workId]?.output, "COMMITTED_FAKE_SUCCESS");
    assert.deepEqual(await Promise.all([readFile(statuses.pathFor(workId), "utf8"), readFile(statuses.terminalPathFor(workId), "utf8")]), files);
    assert.equal((await readFile(path.join(home, "fake-execution.jsonl"), "utf8")).trim().split("\n").length, 1);
    assert.equal((await readFile(path.join(home, "browser-actions.jsonl"), "utf8")).trim().split("\n").length, 1);
    assert.equal((await readRuntimeLease(home, runId)).ownership, "missing");
  });
}
