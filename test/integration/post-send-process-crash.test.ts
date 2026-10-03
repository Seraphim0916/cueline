import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadCueLineRunState, loadCueLineRunStatus } from "../../src/api.js";
import { commandHash, jobId } from "../../src/core/ids.js";
import { JobStatusStore } from "../../src/jobs/status.js";
import { readEvents } from "../../src/state/event-log.js";
import { runPaths } from "../../src/state/paths.js";
import { readRuntimeLease } from "../../src/state/runtime-lease.js";

interface ChildMessage {
  type: "checkpoint" | "result";
  phase?: string;
  pid: number;
  status?: string;
  jobIds?: string[];
}

async function runChild(
  home: string,
  runId: string,
  mode: "crash-submit" | "crash-submit-multi" | "crash-observe" | "crash-job-status" | "continue",
): Promise<ChildMessage> {
  const expectedCheckpoint = mode === "crash-job-status"
    ? "job-registered-before-status"
    : mode === "crash-observe" ? "response-observed" : "submitted";
  const environment: NodeJS.ProcessEnv = { ...process.env, HOME: home, CUELINE_HOME: home };
  delete environment.CUELINE_DEPTH;
  return new Promise<ChildMessage>((resolve, reject) => {
    const child = fork(new URL("../fixtures/post-send-crash-child.js", import.meta.url), [mode, home, runId], {
      execArgv: [],
      silent: true,
      env: environment,
    });
    let output = "";
    let message: ChildMessage | undefined;
    let timedOut = false;
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.stderr?.on("data", (chunk) => { output += String(chunk); });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 30_000);
    child.on("message", (value: ChildMessage) => {
      message = value;
      if (mode !== "continue" && value.type === "checkpoint" && value.phase === expectedCheckpoint) {
        child.kill("SIGKILL");
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    // Wait for close, not just IPC/exit: death and output drainage must be
    // established before another executor inspects the old durable lease.
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      try {
        assert.equal(timedOut, false, `Child ${mode} timed out: ${output}`);
        assert.ok(message, `Child ${mode} sent no result: ${output}`);
        assert.equal(message.pid, child.pid);
        if (mode === "continue") {
          assert.equal(code, 0, output);
          assert.equal(message.type, "result", output);
        } else {
          assert.equal(signal, "SIGKILL", output);
          assert.equal(message.type, "checkpoint", output);
          assert.equal(message.phase, expectedCheckpoint, output);
        }
        resolve(message);
      } catch (error) {
        reject(error);
      }
    });
  });
}

test("real executor death during a multi-job dispatch repairs only missing materialization", async (t) => {
  if (process.platform === "win32") {
    t.skip("The crash barrier asserts POSIX SIGKILL semantics");
    return;
  }
  const home = await mkdtemp(path.join(tmpdir(), "cueline-dispatch-crash-"));
  const runId = "run_multi_job_dispatch_crash";
  const submitted = await runChild(home, runId, "crash-submit-multi");
  const interrupted = await runChild(home, runId, "crash-job-status");
  const interruptedLease = await readRuntimeLease(home, runId);
  assert.equal(interruptedLease.pid, String(interrupted.pid));
  assert.ok(interruptedLease.ownerId);

  const partial = await loadCueLineRunState(runId, { home });
  assert.equal(partial.pendingControllerTurns.length, 0);
  const pending = partial.pendingCommandExecution;
  assert.ok(pending);
  assert.equal(pending.command.action, "dispatch");
  if (pending.command.action !== "dispatch") throw new Error("Expected pending dispatch");
  const command = pending.command;
  assert.equal(command.jobs.length, 3);
  assert.equal(pending.commandHash, commandHash(command));
  const expectedIds = command.jobs.map((spec) => jobId(runId, spec.job_key, spec));
  assert.deepEqual(Object.keys(partial.jobs), expectedIds.slice(0, 2));
  const statusStore = new JobStatusStore(home);
  const originalFirstStatus = await readFile(statusStore.pathFor(expectedIds[0]!), "utf8");
  assert.equal((await statusStore.read(expectedIds[0]!))?.status, "pending");
  assert.equal(await statusStore.read(expectedIds[1]!), undefined);
  assert.equal(await statusStore.read(expectedIds[2]!), undefined);
  const before = await readEvents(runPaths(home, runId).events);
  assert.equal(before.filter((event) => event.type === "job_registered").length, 2);
  const snapshot = JSON.parse(await readFile(runPaths(home, runId).snapshot, "utf8")) as {
    last_sequence: number;
  };
  const lastRegistration = before.filter((event) => event.type === "job_registered").at(-1)!;
  assert.ok(snapshot.last_sequence < lastRegistration.sequence,
    "the registered-only job must survive replay beyond the pre-crash snapshot");
  for (const type of ["caller_jobs_ready", "controller_command_execution_completed", "run_failed"]) {
    assert.equal(before.some((event) => event.type === type), false, type);
  }

  const recovered = await runChild(home, runId, "continue");
  assert.equal(recovered.status, "awaiting_caller");
  assert.deepEqual(recovered.jobIds, expectedIds);
  const repairedStatusFiles = await Promise.all(expectedIds.map((id) => readFile(statusStore.pathFor(id), "utf8")));
  assert.equal(repairedStatusFiles[0], originalFirstStatus, "existing status evidence must not be rewritten");
  for (let index = 0; index < expectedIds.length; index += 1) {
    const status = await statusStore.read(expectedIds[index]!);
    assert.equal(status?.runId, runId);
    assert.equal(status?.jobKey, command.jobs[index]!.job_key);
    assert.equal(status?.lane, "default");
    assert.equal(status?.mode, "advise");
    assert.equal(status?.execution, "foreground");
    assert.equal(status?.status, "pending");
  }

  const repeated = await runChild(home, runId, "continue");
  assert.equal(repeated.status, "awaiting_caller");
  assert.deepEqual(repeated.jobIds, expectedIds);
  assert.deepEqual(await Promise.all(expectedIds.map((id) => readFile(statusStore.pathFor(id), "utf8"))), repairedStatusFiles);
  const finalState = await loadCueLineRunState(runId, { home });
  assert.equal(finalState.pendingCommandExecution, null);
  assert.equal(finalState.pendingControllerTurns.length, 0);
  assert.deepEqual(Object.keys(finalState.jobs), expectedIds);
  const events = await readEvents(runPaths(home, runId).events);
  for (const type of ["controller_turn_requested", "controller_turn_submitted", "controller_response_received", "controller_command_accepted", "caller_jobs_ready", "controller_command_execution_completed"]) {
    assert.equal(events.filter((event) => event.type === type).length, 1, type);
  }
  assert.deepEqual(events.filter((event) => event.type === "job_registered").map((event) =>
    (event.payload as { job: { jobId: string } }).job.jobId), expectedIds);
  assert.equal(events.some((event) => event.type === "caller_work_started"), false);
  const retirements = events.filter((event) => event.type === "runtime_dead_owner_retired");
  assert.equal(retirements.length, 2);
  assert.equal(retirements.filter((event) =>
    (event.payload as { owner_id: string }).owner_id === interruptedLease.ownerId).length, 1);

  const actions = (await readFile(path.join(home, "fake-browser-actions.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line) as {
      method: string; pid: number; runId: string; round: number; requestId: string;
    });
  assert.deepEqual(actions, [
    { method: "submit", pid: submitted.pid, runId, round: command.round, requestId: command.request_id },
    { method: "observe", pid: interrupted.pid, runId, round: command.round, requestId: command.request_id },
  ]);
  const status = await loadCueLineRunStatus(runId, { home });
  assert.equal(status.phase, "caller_jobs_pending");
  assert.equal(status.runtime.ownership, "missing");
  assert.equal(status.safeNextAction, "execute_caller_jobs");
});

for (const loseObservation of [false, true]) {
  test(`real executor death after submission${loseObservation ? " and observation" : ""} never resends or duplicates dispatch`, async (t) => {
    if (process.platform === "win32") {
      t.skip("The crash barrier asserts POSIX SIGKILL semantics");
      return;
    }
    const home = await mkdtemp(path.join(tmpdir(), "cueline-post-send-crash-"));
    const runId = `run_post_send_crash_${loseObservation ? "observed" : "submitted"}`;
    const submitted = await runChild(home, runId, "crash-submit");
    const submittedLease = await readRuntimeLease(home, runId);
    assert.equal(submittedLease.pid, String(submitted.pid));
    assert.ok(submittedLease.ownerId, "SIGKILL must leave a real runtime lease");

    const beforeRecovery = await loadCueLineRunState(runId, { home });
    assert.equal(beforeRecovery.pendingControllerTurns.length, 1);
    const pending = beforeRecovery.pendingControllerTurns[0]!;
    assert.equal(pending.submissionState, "submitted");
    assert.equal(pending.round, 1);
    assert.equal(pending.conversationUrl, "https://chatgpt.com/c/hermetic-post-send-crash");
    assert.deepEqual(Object.keys(beforeRecovery.jobs), []);
    const eventsBeforeRecovery = await readEvents(runPaths(home, runId).events);
    for (const type of ["controller_response_received", "controller_command_accepted", "job_registered", "run_failed"]) {
      assert.equal(eventsBeforeRecovery.some((event) => event.type === type), false, type);
    }
    const snapshot = JSON.parse(await readFile(runPaths(home, runId).snapshot, "utf8")) as {
      last_sequence: number;
    };
    assert.ok(snapshot.last_sequence < eventsBeforeRecovery.at(-1)!.sequence,
      "recovery must replay the submitted checkpoint beyond the pre-crash snapshot");

    let observer: ChildMessage | undefined;
    let observerOwnerId: string | undefined;
    if (loseObservation) {
      observer = await runChild(home, runId, "crash-observe");
      const observerLease = await readRuntimeLease(home, runId);
      assert.equal(observerLease.pid, String(observer.pid));
      assert.notEqual(observerLease.ownerId, submittedLease.ownerId);
      assert.ok(observerLease.ownerId);
      observerOwnerId = observerLease.ownerId;
      const interrupted = await loadCueLineRunState(runId, { home });
      assert.equal(interrupted.pendingControllerTurns[0]?.requestId, pending.requestId);
      assert.deepEqual(Object.keys(interrupted.jobs), []);
      const events = await readEvents(runPaths(home, runId).events);
      for (const type of ["controller_response_received", "controller_command_accepted", "job_registered", "run_failed"]) {
        assert.equal(events.some((event) => event.type === type), false, type);
      }
    }

    const recovered = await runChild(home, runId, "continue");
    assert.equal(recovered.status, "awaiting_caller");
    assert.equal(recovered.jobIds?.length, 1);
    const repeated = await runChild(home, runId, "continue");
    assert.equal(repeated.status, "awaiting_caller");
    assert.deepEqual(repeated.jobIds, recovered.jobIds);

    const events = await readEvents(runPaths(home, runId).events);
    for (const type of ["controller_turn_requested", "controller_turn_submitted", "controller_response_received", "controller_command_accepted", "controller_command_execution_completed", "job_registered"]) {
      assert.equal(events.filter((event) => event.type === type).length, 1, type);
    }
    const retiredOwners = events
      .filter((event) => event.type === "runtime_dead_owner_retired")
      .map((event) => (event.payload as { owner_id: string }).owner_id);
    assert.equal(retiredOwners.length, loseObservation ? 2 : 1);
    assert.ok(retiredOwners.includes(submittedLease.ownerId));
    if (observerOwnerId !== undefined) assert.ok(retiredOwners.includes(observerOwnerId));
    assert.equal(events.some((event) => event.type === "caller_work_started"), false);

    const actions = (await readFile(path.join(home, "fake-browser-actions.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as {
        method: string; pid: number; runId: string; round: number; requestId: string;
      });
    assert.deepEqual(actions.map((action) => action.method), loseObservation
      ? ["submit", "observe", "observe"] : ["submit", "observe"]);
    assert.deepEqual(actions.map((action) => action.pid), loseObservation
      ? [submitted.pid, observer!.pid, recovered.pid] : [submitted.pid, recovered.pid]);
    for (const action of actions) {
      assert.equal(action.runId, runId);
      assert.equal(action.round, pending.round);
      assert.equal(action.requestId, pending.requestId);
    }

    const finalState = await loadCueLineRunState(runId, { home });
    assert.equal(finalState.pendingControllerTurns.length, 0);
    assert.equal(finalState.pendingCommandExecution, null);
    assert.equal(Object.keys(finalState.jobs).length, 1);
    assert.equal((await new JobStatusStore(home).read(recovered.jobIds![0]!))?.status, "pending");
    const status = await loadCueLineRunStatus(runId, { home });
    assert.equal(status.phase, "caller_jobs_pending");
    assert.equal(status.runtime.ownership, "missing");
    assert.equal(status.safeNextAction, "execute_caller_jobs");
  });
}
