import { readdir } from "node:fs/promises";
import path from "node:path";

import type {
  CueLineJobCancellationResult,
  CueLineRunCancellationResult,
  CueLineRuntimeOptions,
  CueLineRuntimeReconciliationResult,
  CueLineRuntimeTakeoverResult,
  CueLineRunListEntry,
} from "./api-contracts.js";
import type { CueLineResult } from "./core/controller-loop.js";
import { CueLineError } from "./core/errors.js";
import {
  loadPersistedRunState,
  loadPersistedRunStore,
} from "./core/persisted-run.js";
import { processOrGroupIsAlive } from "./core/process-liveness.js";
import { runtimeEnvironment } from "./core/runtime.js";
import {
  acceptedControllerCommandEvidence,
  summarizeCueLineRunState,
  type CueLineRunStatusSummary,
} from "./core/run-status.js";
import type { CueLineRunState, StoredJob } from "./core/state-machine.js";
import { JobStatusStore, type JobStatus } from "./jobs/status.js";
import {
  readCancellationObservation,
  requestJobCancellation,
  requestRunCancellation,
} from "./state/cancellation.js";
import { defaultCueLineHome, runPaths } from "./state/paths.js";
import {
  readRuntimeLease,
  retireDeadRuntimeLease,
  RuntimeLease,
} from "./state/runtime-lease.js";
import { readAuthoritativeRunEvents, type RunStore } from "./state/store.js";

function terminalResult(state: CueLineRunState): CueLineResult {
  if (
    state.status !== "complete" &&
    state.status !== "blocked" &&
    state.status !== "cancelled"
  ) {
    throw new CueLineError("RUN_NOT_TERMINAL", "CueLine result requested before a terminal state.");
  }
  return {
    runId: state.runId,
    status: state.status,
    ...(state.finalDeliveryText === null ? {} : { finalDeliveryText: state.finalDeliveryText }),
    ...(state.conversationUrl === null ? {} : { conversationUrl: state.conversationUrl }),
    ...(state.cancelledReason === null ? {} : { cancelledReason: state.cancelledReason }),
    state,
  };
}

export async function loadCueLineRunState(
  runId: string,
  options: Pick<CueLineRuntimeOptions, "home" | "environment"> = {},
): Promise<CueLineRunState> {
  const environment = options.environment ?? runtimeEnvironment();
  return loadPersistedRunState(options.home ?? defaultCueLineHome(environment), runId);
}

export async function loadCueLineRunStatus(
  runId: string,
  options: Pick<CueLineRuntimeOptions, "home" | "environment" | "now"> = {},
): Promise<CueLineRunStatusSummary> {
  const environment = options.environment ?? runtimeEnvironment();
  const home = options.home ?? defaultCueLineHome(environment);
  const store = await loadPersistedRunStore(home, runId);
  const runtime = await readRuntimeLease(home, runId, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const cancellation = await readCancellationObservation(home, runId);
  const acceptedCommand = acceptedControllerCommandEvidence(
    await readAuthoritativeRunEvents(home, runId),
  );
  const statusStore = new JobStatusStore(home);
  const persistedJobStatuses = new Map(
    (await Promise.all(
      Object.keys(store.state.jobs).map(async (jobId) => [
        jobId,
        await statusStore.read(jobId),
      ] as const),
    )).flatMap(([jobId, status]) => status === undefined ? [] : [[jobId, status] as const]),
  );
  return summarizeCueLineRunState(
    store.state,
    store.lastSequence,
    runtime,
    cancellation,
    acceptedCommand,
    persistedJobStatuses,
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function runListErrorCode(error: unknown): string {
  return error instanceof CueLineError ? error.code : "RUN_UNREADABLE";
}

function validRunDirectory(home: string, name: string): boolean {
  try {
    runPaths(home, name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns a sanitized, read-only inventory. It intentionally omits requests,
 * controller text, conversation URLs, job tasks, and worker output.
 */
export async function listCueLineRuns(
  options: Pick<CueLineRuntimeOptions, "home" | "environment" | "now"> = {},
): Promise<CueLineRunListEntry[]> {
  const environment = options.environment ?? runtimeEnvironment();
  const home = options.home ?? defaultCueLineHome(environment);
  let directories;
  try {
    directories = await readdir(path.join(home, "runs"), { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }

  const entries: CueLineRunListEntry[] = [];
  for (const directory of directories) {
    if (!directory.isDirectory() || !validRunDirectory(home, directory.name)) continue;
    try {
      const [status, events] = await Promise.all([
        loadCueLineRunStatus(directory.name, options),
        readAuthoritativeRunEvents(home, directory.name),
      ]);
      const lastEvent = events.at(-1);
      if (lastEvent === undefined) {
        entries.push({
          runId: directory.name,
          readable: false,
          errorCode: "RUN_NOT_FOUND",
        });
        continue;
      }
      entries.push({
        runId: status.runId,
        readable: true,
        status: status.status,
        executor: status.executor,
        phase: status.phase,
        round: status.round,
        pendingTurns: status.controller.pendingTurns,
        activeJobs: status.jobs.counts.pending + status.jobs.counts.running,
        runtimeOwnership: status.runtime.ownership,
        safeNextAction: status.safeNextAction,
        lastEventSequence: status.lastEventSequence,
        lastEventAt: lastEvent.timestamp,
      });
    } catch (error) {
      entries.push({
        runId: directory.name,
        readable: false,
        errorCode: runListErrorCode(error),
      });
    }
  }

  return entries.sort((left, right) => {
    if (left.readable !== right.readable) return left.readable ? -1 : 1;
    if (left.readable && right.readable && left.lastEventAt !== right.lastEventAt) {
      return right.lastEventAt.localeCompare(left.lastEventAt);
    }
    return left.runId.localeCompare(right.runId);
  });
}

/**
 * Explicitly releases one exact stale owner. This is the operator-authorized
 * path for shared Node/REPL hosts whose PID remains alive after the outer tool
 * call disappeared. It never steals an active or newly-heartbeating lease.
 */
export async function takeoverCueLineRuntime(
  runId: string,
  options: Pick<CueLineRuntimeOptions, "home" | "environment" | "now"> = {},
): Promise<CueLineRuntimeTakeoverResult> {
  const environment = options.environment ?? runtimeEnvironment();
  const home = options.home ?? defaultCueLineHome(environment);
  const state = await loadPersistedRunState(home, runId);
  if (isTerminalRun(state)) {
    return { runId, outcome: "already_terminal", next: "none" };
  }
  const runtime = await readRuntimeLease(home, runId, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (runtime.ownership === "missing" || runtime.ownership === "released") {
    return {
      runId,
      outcome: "already_available",
      next: state.executor === "process" ? "reconcile_runtime" : "continue",
    };
  }
  if (runtime.ownership === "invalid") {
    throw new CueLineError(
      "RUNTIME_LEASE_INVALID",
      `Run '${runId}' has unreadable runtime ownership evidence; refusing takeover.`,
    );
  }
  if (runtime.ownership === "active") {
    throw new CueLineError(
      "RUNTIME_TAKEOVER_ACTIVE_REFUSED",
      `Run '${runId}' still has a fresh runtime heartbeat; refusing takeover.`,
    );
  }
  if (runtime.ownerId === undefined || runtime.heartbeatAt === undefined) {
    throw new CueLineError(
      "RUNTIME_TAKEOVER_EVIDENCE_MISSING",
      `Run '${runId}' lacks the exact owner and heartbeat evidence required for takeover.`,
    );
  }
  const takeoverStore = await loadPersistedRunStore(home, runId);
  let lease: RuntimeLease;
  try {
    lease = await RuntimeLease.takeoverStale({
      home,
      runId,
      expectedOwnerId: runtime.ownerId,
      expectedHeartbeatAt: runtime.heartbeatAt,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  } catch (error) {
    if (
      error instanceof CueLineError &&
      (error.code === "RUNTIME_TAKEOVER_RACE" ||
        error.code === "RUNTIME_MUTATION_FENCED")
    ) {
      throw new CueLineError(
        "RUNTIME_TAKEOVER_RACE",
        `Run '${runId}' changed while takeover was being confirmed; inspect current status and retry only if it is still stale.`,
        { cause: error },
      );
    }
    throw error;
  }
  try {
    takeoverStore.bindRuntimeOwner(lease.ownerId);
    await takeoverStore.append("runtime_stale_owner_takeover_requested", {
      previous_owner_id: runtime.ownerId,
      previous_heartbeat_at: runtime.heartbeatAt,
      previous_age_ms: runtime.ageMs ?? null,
      operator_confirmation: true,
      intent_persisted_before_replacement: true,
    });
    await takeoverStore.append("runtime_stale_owner_takeover_confirmed", {
      previous_owner_id: runtime.ownerId,
      previous_heartbeat_at: runtime.heartbeatAt,
      previous_age_ms: runtime.ageMs ?? null,
      operator_confirmation: true,
    });
    await takeoverStore.snapshot();
    return {
      runId,
      outcome: "taken_over",
      next:
        takeoverStore.state.executor === "process" ? "reconcile_runtime" : "continue",
      previousOwnerId: runtime.ownerId,
    };
  } finally {
    await lease.release();
  }
}

export async function reconcileCueLineRuntime(
  runId: string,
  options: Pick<CueLineRuntimeOptions, "home" | "environment" | "now"> = {},
): Promise<CueLineRuntimeReconciliationResult> {
  const environment = options.environment ?? runtimeEnvironment();
  const home = options.home ?? defaultCueLineHome(environment);
  const initialStore = await loadPersistedRunStore(home, runId);
  if (isTerminalRun(initialStore.state)) {
    return {
      runId,
      outcome: "already_terminal",
      affectedJobs: 0,
      survivingJobs: [],
    };
  }
  if (initialStore.state.executor === "caller") {
    throw new CueLineError(
      "PROCESS_EXECUTOR_REQUIRED",
      `Run '${runId}' uses caller execution and has no process runtime to reconcile.`,
    );
  }
  let runtime = await readRuntimeLease(home, runId, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (runtime.ownership === "invalid") {
    throw new CueLineError(
      "RUNTIME_LEASE_INVALID",
      `Run '${runId}' has unreadable runtime ownership evidence.`,
    );
  }
  if (runtime.ownership === "active" || runtime.ownership === "stale") {
    if (
      runtime.ownerId === undefined ||
      !(await retireDeadRuntimeLease(home, runId, runtime.ownerId))
    ) {
      return {
        runId,
        outcome: "owner_alive",
        affectedJobs: 0,
        survivingJobs: [],
      };
    }
    runtime = await readRuntimeLease(home, runId);
  }
  if (runtime.ownership !== "missing" && runtime.ownership !== "released") {
    return {
      runId,
      outcome: "owner_alive",
      affectedJobs: 0,
      survivingJobs: [],
    };
  }
  const previousOwnership = runtime.ownership;
  let lease: RuntimeLease;
  try {
    lease = await RuntimeLease.claim({
      home,
      runId,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  } catch (error) {
    if (
      error instanceof CueLineError &&
      (error.code === "RUN_ALREADY_ACTIVE" ||
        error.code === "RUN_CLAIM_IN_PROGRESS" ||
        error.code === "RUN_STALE_REQUIRES_TAKEOVER")
    ) {
      return {
        runId,
        outcome: "owner_alive",
        affectedJobs: 0,
        survivingJobs: [],
      };
    }
    throw error;
  }
  try {
    const store = await loadPersistedRunStore(home, runId);
    store.bindRuntimeOwner(lease.ownerId);
    if (isTerminalRun(store.state)) {
      return {
        runId,
        outcome: "already_terminal",
        affectedJobs: 0,
        survivingJobs: [],
      };
    }
    if (store.state.executor === "caller") {
      throw new CueLineError(
        "PROCESS_EXECUTOR_REQUIRED",
        `Run '${runId}' uses caller execution and has no process runtime to reconcile.`,
      );
    }

    const statusStore = new JobStatusStore(home);
    const activeJobs = Object.values(store.state.jobs).filter(
      (job) => job.status === "pending" || job.status === "running",
    );
    const survivingJobs: string[] = [];
    let affectedJobs = 0;
    await store.append("runtime_reconciliation_started", {
      previous_ownership: previousOwnership,
      active_job_ids: activeJobs.map((job) => job.jobId),
    });
    for (const job of activeJobs) {
      const persisted = await statusStore.read(job.jobId);
      if (persisted?.pid !== undefined && processOrGroupIsAlive(persisted.pid)) {
        survivingJobs.push(job.jobId);
        continue;
      }
      if (persisted !== undefined && isPersistedTerminalStatus(persisted)) {
        assertPersistedJobIdentity(persisted, runId, job);
        await store.append("job_status", persistedTerminalPayload(job, persisted));
        affectedJobs += 1;
        continue;
      }
      const status = job.spec.mode === "work" ? "ambiguous" : "failed";
      await store.append("job_status", {
        job_id: job.jobId,
        status,
        error:
          job.spec.mode === "work"
            ? "The runtime owner and worker process disappeared; work side effects cannot be proven."
            : "The runtime owner and worker process disappeared before the advise job produced a terminal result.",
      });
      affectedJobs += 1;
    }
    if (survivingJobs.length > 0) {
      await store.append("notice", {
        message: `runtime reconciliation found ${survivingJobs.length} worker process(es) still alive; refusing to invent terminal states`,
      });
      await store.snapshot();
      return { runId, outcome: "processes_alive", affectedJobs, survivingJobs };
    }
    await store.append("runtime_owner_loss_reconciled", {
      affected_jobs: affectedJobs,
    });
    if (store.state.status === "running") {
      await store.append("run_failed", {
        code: "RUNTIME_OWNER_LOST",
        message:
          "The previous runtime owner disappeared; active jobs were reconciled from persisted process evidence.",
        stage: "runtime_reconciliation",
      });
    }
    await store.snapshot();
    return { runId, outcome: "reconciled", affectedJobs, survivingJobs: [] };
  } finally {
    await lease.release();
  }
}

export function isTerminalRun(state: CueLineRunState): boolean {
  return (
    state.status === "complete" || state.status === "blocked" || state.status === "cancelled"
  );
}

function isPersistedTerminalStatus(status: JobStatus): boolean {
  return status.status !== "pending" && status.status !== "running";
}

function assertPersistedJobIdentity(
  persisted: JobStatus,
  runId: string,
  job: StoredJob,
): void {
  const mismatch =
    (persisted.runId !== undefined && persisted.runId !== runId) ||
    (persisted.jobKey !== undefined && persisted.jobKey !== job.jobKey) ||
    (persisted.lane !== undefined && persisted.lane !== job.spec.lane) ||
    (persisted.mode !== undefined && persisted.mode !== job.spec.mode);
  if (mismatch) {
    throw new CueLineError(
      "JOB_STATUS_IDENTITY_MISMATCH",
      `Persisted status for job '${job.jobId}' does not match run '${runId}'.`,
    );
  }
}

function persistedTerminalPayload(
  job: StoredJob,
  persisted: JobStatus,
): Record<string, unknown> {
  const fullOutput = persisted.result?.output;
  const stdout = persisted.result?.stdout;
  const controllerOutput =
    persisted.status === "succeeded" && stdout?.trim() ? stdout : fullOutput;
  return {
    job_id: job.jobId,
    status: persisted.status,
    ...(controllerOutput === undefined ? {} : { output: controllerOutput }),
    ...(persisted.error === undefined ? {} : { error: persisted.error }),
  };
}

async function appendPersistedTerminalIfPresent(
  store: RunStore<CueLineRunState>,
  statusStore: JobStatusStore,
  runId: string,
  job: StoredJob,
): Promise<JobStatus | undefined> {
  const persisted = await statusStore.read(job.jobId);
  if (persisted === undefined || !isPersistedTerminalStatus(persisted)) return undefined;
  assertPersistedJobIdentity(persisted, runId, job);
  await store.append("job_status", persistedTerminalPayload(job, persisted));
  return persisted;
}

async function persistOwnerlessJobTerminal(
  home: string,
  runId: string,
  job: StoredJob,
  status: "cancelled" | "ambiguous",
  error: string,
  now: () => Date,
): Promise<void> {
  const statusStore = new JobStatusStore(home);
  const existing = await statusStore.read(job.jobId);
  if (existing !== undefined && isPersistedTerminalStatus(existing)) {
    assertPersistedJobIdentity(existing, runId, job);
    throw new CueLineError(
      "JOB_TERMINAL_EVIDENCE_EXISTS",
      `Job '${job.jobId}' already has terminal execution evidence and cannot be overwritten.`,
    );
  }
  const timestamp = now().toISOString();
  await statusStore.write({
    jobId: job.jobId,
    runId,
    jobKey: job.jobKey,
    lane: job.spec.lane,
    mode: job.spec.mode,
    execution: existing?.execution ?? "foreground",
    status,
    startedAt: existing?.startedAt ?? timestamp,
    finishedAt: timestamp,
    ...(existing?.pid === undefined ? {} : { pid: existing.pid }),
    error,
  });
}

async function livePersistedProcessJobs(
  home: string,
  jobs: Iterable<StoredJob>,
): Promise<string[]> {
  const statusStore = new JobStatusStore(home);
  const live: string[] = [];
  for (const job of jobs) {
    const persisted = await statusStore.read(job.jobId);
    if (persisted?.pid !== undefined && processOrGroupIsAlive(persisted.pid)) {
      live.push(job.jobId);
    }
  }
  return live;
}

function ownerlessTerminalEvidence(
  job: StoredJob,
): { status: "cancelled" | "ambiguous"; error: string } | undefined {
  if (job.status === "cancelled") {
    return {
      status: "cancelled",
      error:
        job.error ??
        "Caller job was cancelled before execution evidence was submitted.",
    };
  }
  if (job.status === "ambiguous") {
    return {
      status: "ambiguous",
      error:
        job.error ??
        "Job cancelled without a verifiable active runtime; process outcome is unknown.",
    };
  }
  return undefined;
}

async function repairOwnerlessTerminalStatus(
  home: string,
  runId: string,
  job: StoredJob,
  now: () => Date,
): Promise<void> {
  const terminal = ownerlessTerminalEvidence(job);
  if (terminal === undefined) return;
  const persisted = await new JobStatusStore(home).read(job.jobId);
  if (persisted?.status === terminal.status) return;
  if (
    persisted !== undefined &&
    persisted.status !== "pending" &&
    persisted.status !== "running"
  ) {
    return;
  }
  await persistOwnerlessJobTerminal(
    home,
    runId,
    job,
    terminal.status,
    terminal.error,
    now,
  );
}

async function repairOwnerlessTerminalStatuses(
  home: string,
  runId: string,
  jobs: Iterable<StoredJob>,
  now: () => Date,
): Promise<void> {
  for (const job of jobs) {
    await repairOwnerlessTerminalStatus(home, runId, job, now);
  }
}

export async function cancelCueLineRun(
  runId: string,
  options: Pick<CueLineRuntimeOptions, "home" | "environment" | "now"> & {
    reason?: string;
  } = {},
): Promise<CueLineRunCancellationResult> {
  const environment = options.environment ?? runtimeEnvironment();
  const home = options.home ?? defaultCueLineHome(environment);
  let store = await loadPersistedRunStore(home, runId);
  if (isTerminalRun(store.state)) {
    await repairOwnerlessTerminalStatuses(
      home,
      runId,
      Object.values(store.state.jobs),
      options.now ?? (() => new Date()),
    );
    return { runId, outcome: "already_terminal", affectedJobs: 0 };
  }
  const reason = options.reason ?? "operator requested cancellation";
  await requestRunCancellation(home, runId, reason, options.now);
  let runtime = await readRuntimeLease(home, runId, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const retiredOwner =
    (runtime.ownership === "active" || runtime.ownership === "stale") &&
    runtime.ownerId !== undefined &&
    (await retireDeadRuntimeLease(home, runId, runtime.ownerId))
      ? { ownerId: runtime.ownerId, ownership: runtime.ownership }
      : undefined;
  if (retiredOwner !== undefined) {
    runtime = await readRuntimeLease(home, runId, {
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }
  if (runtime.ownership === "active" || runtime.ownership === "stale") {
    return { runId, outcome: "requested", affectedJobs: 0 };
  }
  if (runtime.ownership === "invalid") {
    throw new CueLineError(
      "RUNTIME_LEASE_INVALID",
      `Run '${runId}' has unreadable runtime ownership evidence; cancellation was recorded but cannot be claimed safely.`,
    );
  }
  let lease: RuntimeLease;
  try {
    lease = await RuntimeLease.claim({
      home,
      runId,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  } catch (error) {
    if (
      error instanceof CueLineError &&
      (error.code === "RUN_ALREADY_ACTIVE" || error.code === "RUN_CLAIM_IN_PROGRESS")
    ) {
      return { runId, outcome: "requested", affectedJobs: 0 };
    }
    throw error;
  }
  try {
    store = await loadPersistedRunStore(home, runId);
    store.bindRuntimeOwner(lease.ownerId);
    if (retiredOwner !== undefined) {
      await store.append("runtime_dead_owner_retired", {
        owner_id: retiredOwner.ownerId,
        previous_ownership: retiredOwner.ownership,
      });
    }
    if (isTerminalRun(store.state)) {
      await repairOwnerlessTerminalStatuses(
        home,
        runId,
        Object.values(store.state.jobs),
        options.now ?? (() => new Date()),
      );
      return { runId, outcome: "already_terminal", affectedJobs: 0 };
    }
    const active = Object.values(store.state.jobs).filter(
      (job) => job.status === "pending" || job.status === "running",
    );
    if (store.state.executor === "process") {
      const survivingJobs = await livePersistedProcessJobs(home, active);
      if (survivingJobs.length > 0) {
        await store.append("notice", {
          message:
            "cancellation remains pending because ownerless worker process groups are still alive",
          surviving_job_ids: survivingJobs,
        });
        await store.snapshot();
        return { runId, outcome: "requested", affectedJobs: 0 };
      }
    }
    const cancellationNow = options.now ?? (() => new Date());
    const cancellationStatusStore = new JobStatusStore(home);
    for (const job of active) {
      if (
        (await appendPersistedTerminalIfPresent(
          store,
          cancellationStatusStore,
          runId,
          job,
        )) !== undefined
      ) {
        continue;
      }
      const callerPending = store.state.executor === "caller" && job.status === "pending";
      const terminalStatus = callerPending ? "cancelled" : "ambiguous";
      const terminalError = callerPending
        ? "Caller job was cancelled before execution evidence was submitted."
        : "Run cancelled without a verifiable active runtime; process outcome is unknown.";
      await persistOwnerlessJobTerminal(
        home,
        runId,
        job,
        terminalStatus,
        terminalError,
        cancellationNow,
      );
      await store.append("job_status", {
        job_id: job.jobId,
        status: terminalStatus,
        error: terminalError,
      });
    }
    await store.append("run_cancelled", { reason });
    await store.snapshot();
    return { runId, outcome: "cancelled", affectedJobs: active.length };
  } finally {
    await lease.release();
  }
}

export async function cancelCueLineJob(
  runId: string,
  jobId: string,
  options: Pick<CueLineRuntimeOptions, "home" | "environment" | "now"> & {
    reason?: string;
  } = {},
): Promise<CueLineJobCancellationResult> {
  const environment = options.environment ?? runtimeEnvironment();
  const home = options.home ?? defaultCueLineHome(environment);
  let store = await loadPersistedRunStore(home, runId);
  let job = store.state.jobs[jobId];
  if (job === undefined) {
    throw new CueLineError("JOB_NOT_FOUND", `No job '${jobId}' exists in run '${runId}'.`);
  }
  if (
    isTerminalRun(store.state) ||
    (job.status !== "pending" && job.status !== "running")
  ) {
    await repairOwnerlessTerminalStatus(
      home,
      runId,
      job,
      options.now ?? (() => new Date()),
    );
    return { runId, jobId, outcome: "already_terminal" };
  }
  const reason = options.reason ?? "operator requested job cancellation";
  await requestJobCancellation(home, runId, jobId, reason, options.now);
  let runtime = await readRuntimeLease(home, runId, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const retiredOwner =
    (runtime.ownership === "active" || runtime.ownership === "stale") &&
    runtime.ownerId !== undefined &&
    (await retireDeadRuntimeLease(home, runId, runtime.ownerId))
      ? { ownerId: runtime.ownerId, ownership: runtime.ownership }
      : undefined;
  if (retiredOwner !== undefined) {
    runtime = await readRuntimeLease(home, runId, {
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }
  if (runtime.ownership === "active" || runtime.ownership === "stale") {
    return { runId, jobId, outcome: "requested" };
  }
  if (runtime.ownership === "invalid") {
    throw new CueLineError(
      "RUNTIME_LEASE_INVALID",
      `Run '${runId}' has unreadable runtime ownership evidence; job cancellation was recorded but cannot be claimed safely.`,
    );
  }
  let lease: RuntimeLease;
  try {
    lease = await RuntimeLease.claim({
      home,
      runId,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  } catch (error) {
    if (
      error instanceof CueLineError &&
      (error.code === "RUN_ALREADY_ACTIVE" || error.code === "RUN_CLAIM_IN_PROGRESS")
    ) {
      return { runId, jobId, outcome: "requested" };
    }
    throw error;
  }
  try {
    store = await loadPersistedRunStore(home, runId);
    store.bindRuntimeOwner(lease.ownerId);
    if (retiredOwner !== undefined) {
      await store.append("runtime_dead_owner_retired", {
        owner_id: retiredOwner.ownerId,
        previous_ownership: retiredOwner.ownership,
      });
    }
    job = store.state.jobs[jobId];
    if (!job) {
      throw new CueLineError("JOB_NOT_FOUND", `No job '${jobId}' exists in run '${runId}'.`);
    }
    if (job.status !== "pending" && job.status !== "running") {
      await repairOwnerlessTerminalStatus(
        home,
        runId,
        job,
        options.now ?? (() => new Date()),
      );
      return { runId, jobId, outcome: "already_terminal" };
    }
    if (store.state.executor === "caller" && job.status === "pending") {
      if (
        (await appendPersistedTerminalIfPresent(
          store,
          new JobStatusStore(home),
          runId,
          job,
        )) !== undefined
      ) {
        await store.snapshot();
        return { runId, jobId, outcome: "already_terminal" };
      }
      const error = "Caller job was cancelled before execution evidence was submitted.";
      await persistOwnerlessJobTerminal(
        home,
        runId,
        job,
        "cancelled",
        error,
        options.now ?? (() => new Date()),
      );
      await store.append("job_status", {
        job_id: jobId,
        status: "cancelled",
        error,
      });
      await store.snapshot();
      return { runId, jobId, outcome: "cancelled" };
    }
    const survivingJobs = await livePersistedProcessJobs(home, [job]);
    if (survivingJobs.length > 0) {
      await store.append("notice", {
        message: `job cancellation remains pending because worker process group '${jobId}' is still alive`,
        surviving_job_ids: survivingJobs,
      });
      await store.snapshot();
      return { runId, jobId, outcome: "requested" };
    }
    if (
      (await appendPersistedTerminalIfPresent(
        store,
        new JobStatusStore(home),
        runId,
        job,
      )) !== undefined
    ) {
      await store.snapshot();
      return { runId, jobId, outcome: "already_terminal" };
    }
    const ambiguousError =
      "Job cancelled without a verifiable active runtime; process outcome is unknown.";
    await persistOwnerlessJobTerminal(
      home,
      runId,
      job,
      "ambiguous",
      ambiguousError,
      options.now ?? (() => new Date()),
    );
    await store.append("job_status", {
      job_id: jobId,
      status: "ambiguous",
      error: ambiguousError,
    });
    if (store.state.status === "running") {
      await store.append("run_failed", {
        code: "JOB_CANCELLED_WITHOUT_ACTIVE_RUNTIME",
        message: `Job '${jobId}' was marked ambiguous because no active owner could confirm termination.`,
        stage: "job_cancellation",
      });
    }
    await store.snapshot();
    return { runId, jobId, outcome: "ambiguous" };
  } finally {
    await lease.release();
  }
}

export { terminalResult };
