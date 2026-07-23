import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import type {
  CueLineCallerWorkClaimOptions,
  CueLineCallerWorkClaimProof,
  CueLineCallerWorkClaimResult,
  CueLineCallerWorkMutationOptions,
  CueLineCallerWorkMutationResult,
  CueLineCallerWorkProgressInput,
  CueLineCallerWorkProgressKind,
} from "./api-contracts.js";
import { CueLineError } from "./core/errors.js";
import { jobSpecHash } from "./core/ids.js";
import { loadPersistedRunStore } from "./core/persisted-run.js";
import { runtimeEnvironment } from "./core/runtime.js";
import type {
  CallerWorkClaim,
  CallerWorkdirIdentity,
  CueLineRunState,
  StoredJob,
} from "./core/state-machine.js";
import { JobStatusStore, type JobStatus } from "./jobs/status.js";
import { defaultCueLineHome } from "./state/paths.js";
import {
  readRuntimeLease,
  retireDeadRuntimeLease,
  RuntimeLease,
} from "./state/runtime-lease.js";
import {
  readAuthoritativeRunEvents,
  type RunStore,
} from "./state/store.js";

const DEFAULT_CALLER_WORK_CLAIM_TTL_MS = 300_000;
const MIN_CALLER_WORK_CLAIM_TTL_MS = 1_000;
const MAX_CALLER_WORK_CLAIM_TTL_MS = 86_400_000;
const CALLER_WORK_PROGRESS_KINDS = new Set<CueLineCallerWorkProgressKind>([
  "tool_completed",
  "checkpoint_persisted",
  "verification_completed",
]);

type CallerWorkMutationOptions = CueLineCallerWorkMutationOptions;

export interface CallerWorkReviewInput {
  reasonCode: "progress_stalled" | "max_execution_elapsed";
  reason: string;
  limitMs: number;
}

function assertCallerId(value: string): void {
  if (value.trim() === "" || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new CueLineError(
      "CALLER_ID_INVALID",
      "callerId must be a non-empty printable identifier of at most 256 characters.",
    );
  }
}

function validatedTtlMs(value: number | undefined): number {
  const ttlMs = value ?? DEFAULT_CALLER_WORK_CLAIM_TTL_MS;
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < MIN_CALLER_WORK_CLAIM_TTL_MS ||
    ttlMs > MAX_CALLER_WORK_CLAIM_TTL_MS
  ) {
    throw new CueLineError(
      "CALLER_WORK_CLAIM_TTL_INVALID",
      `Caller work claim ttlMs must be an integer from ${MIN_CALLER_WORK_CLAIM_TTL_MS} to ${MAX_CALLER_WORK_CLAIM_TTL_MS}.`,
    );
  }
  return ttlMs;
}

function assertClaimProof(value: CueLineCallerWorkClaimProof): void {
  assertCallerId(value.callerId);
  if (value.claimId.trim() === "" || !Number.isSafeInteger(value.fencingToken)) {
    throw new CueLineError(
      "CALLER_WORK_CLAIM_PROOF_INVALID",
      "Caller work proof requires a non-empty claimId and a safe integer fencingToken.",
    );
  }
}

function assertProgressInput(
  value: CueLineCallerWorkProgressInput | null | undefined,
): asserts value is CueLineCallerWorkProgressInput {
  if (
    value === null ||
    value === undefined ||
    !CALLER_WORK_PROGRESS_KINDS.has(value.kind) ||
    !/^[0-9a-f]{64}$/.test(value.evidenceHash)
  ) {
    throw new CueLineError(
      "CALLER_WORK_PROGRESS_INVALID",
      "Caller work progress requires an allowed kind and a lowercase SHA-256 evidenceHash.",
    );
  }
}

function callerWorkJob(store: RunStore<CueLineRunState>, jobId: string): StoredJob {
  if (store.state.executor !== "caller") {
    throw new CueLineError(
      "CALLER_EXECUTOR_REQUIRED",
      `Run '${store.runId}' uses the process executor; caller work cannot be claimed.`,
    );
  }
  const job = store.state.jobs[jobId];
  if (!job) {
    throw new CueLineError("JOB_NOT_FOUND", `No job '${jobId}' exists in run '${store.runId}'.`);
  }
  if (job.spec.mode !== "work") {
    throw new CueLineError(
      "CALLER_WORK_JOB_REQUIRED",
      `Job '${jobId}' is advise-only and does not use a caller work claim.`,
    );
  }
  if (job.spec.workdir === undefined || !path.isAbsolute(job.spec.workdir)) {
    throw new CueLineError(
      "CALLER_WORKDIR_REQUIRED",
      `Caller work job '${jobId}' is not bound to an absolute workdir.`,
    );
  }
  return job;
}

async function inspectWorkdir(workdir: string): Promise<CallerWorkdirIdentity> {
  const resolvedPath = await realpath(workdir).catch((error: unknown) => {
    throw new CueLineError(
      "CALLER_WORKDIR_UNAVAILABLE",
      `Caller workdir '${workdir}' is unavailable.`,
      { cause: error },
    );
  });
  const metadata = await stat(resolvedPath).catch((error: unknown) => {
    throw new CueLineError(
      "CALLER_WORKDIR_UNAVAILABLE",
      `Caller workdir '${workdir}' is unavailable.`,
      { cause: error },
    );
  });
  if (!metadata.isDirectory()) {
    throw new CueLineError(
      "CALLER_WORKDIR_UNAVAILABLE",
      `Caller workdir '${workdir}' is not a directory.`,
    );
  }
  return {
    resolvedPath,
    device: String(metadata.dev),
    inode: String(metadata.ino),
  };
}

function sameWorkdirIdentity(
  left: CallerWorkdirIdentity,
  right: CallerWorkdirIdentity,
): boolean {
  return (
    left.resolvedPath === right.resolvedPath &&
    left.device === right.device &&
    left.inode === right.inode
  );
}

async function assertClaimedWorkdir(claim: CallerWorkClaim): Promise<CallerWorkdirIdentity> {
  if (claim.workdirIdentity === undefined) {
    throw new CueLineError(
      "CALLER_WORKDIR_IDENTITY_REQUIRED",
      `Caller work claim '${claim.claimId}' predates directory pinning; reclaim it with the same caller before starting local work.`,
    );
  }
  const observed = await inspectWorkdir(claim.workdir);
  if (!sameWorkdirIdentity(observed, claim.workdirIdentity)) {
    throw new CueLineError(
      "CALLER_WORKDIR_IDENTITY_MISMATCH",
      `Caller workdir '${claim.workdir}' no longer identifies the directory pinned by claim '${claim.claimId}'.`,
      {
        details: {
          expected_resolved_path: claim.workdirIdentity.resolvedPath,
          observed_resolved_path: observed.resolvedPath,
        },
      },
    );
  }
  return observed;
}

function claimExpired(claim: CallerWorkClaim, now: Date): boolean {
  const expiresAt = Date.parse(claim.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime();
}

function assertClaimClockMonotonic(claim: CallerWorkClaim, now: Date): void {
  const heartbeatAt = Date.parse(claim.heartbeatAt);
  if (!Number.isFinite(heartbeatAt) || now.getTime() < heartbeatAt) {
    throw new CueLineError(
      "CALLER_WORK_CLOCK_REGRESSION",
      `Caller work clock moved behind the durable heartbeat for claim '${claim.claimId}'; refusing a transition that the event reducer would reject.`,
      {
        details: {
          claim_id: claim.claimId,
          heartbeat_at: claim.heartbeatAt,
          observed_at: now.toISOString(),
        },
      },
    );
  }
}

function expiration(now: Date, ttlMs: number): string {
  return new Date(now.getTime() + ttlMs).toISOString();
}

async function writeClaimJobStatus(
  home: string,
  store: RunStore<CueLineRunState>,
  job: StoredJob,
  status: "pending" | "running" | "ambiguous",
  timestamp: string,
  error?: string,
  progress?: { phase: string; lastProgressAt: string },
): Promise<void> {
  const statusStore = new JobStatusStore(home);
  const existing = await statusStore.read(job.jobId);
  const startedAt =
    status === "running" && existing?.status !== "running"
      ? timestamp
      : (existing?.startedAt ?? timestamp);
  const phase = progress?.phase ?? existing?.phase;
  const lastProgressAt = progress?.lastProgressAt ?? existing?.lastProgressAt;
  const next: JobStatus = {
    jobId: job.jobId,
    runId: store.runId,
    jobKey: job.jobKey,
    lane: job.spec.lane,
    mode: job.spec.mode,
    execution: "foreground",
    status,
    startedAt,
    ...(phase === undefined ? {} : { phase }),
    ...(lastProgressAt === undefined ? {} : { lastProgressAt }),
    ...(status === "ambiguous" ? { finishedAt: timestamp } : {}),
    ...(error === undefined ? {} : { error }),
  };
  await statusStore.write(next);
}

function priorProgressEvidence(
  events: Awaited<ReturnType<typeof readAuthoritativeRunEvents>>,
  jobId: string,
  claimId: string,
  evidenceHash: string,
): { progressAt: string; progressKind: CueLineCallerWorkProgressKind } | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event?.type !== "caller_work_progress" ||
      typeof event.payload !== "object" ||
      event.payload === null ||
      Array.isArray(event.payload)
    ) {
      continue;
    }
    const payload = event.payload as Record<string, unknown>;
    if (
      payload.job_id === jobId &&
      payload.claim_id === claimId &&
      payload.progress_evidence_hash === evidenceHash &&
      typeof payload.progress_at === "string" &&
      Number.isFinite(Date.parse(payload.progress_at)) &&
      typeof payload.progress_kind === "string" &&
      CALLER_WORK_PROGRESS_KINDS.has(
        payload.progress_kind as CueLineCallerWorkProgressKind,
      )
    ) {
      return {
        progressAt: payload.progress_at,
        progressKind: payload.progress_kind as CueLineCallerWorkProgressKind,
      };
    }
  }
  return undefined;
}

async function markStartedClaimAmbiguous(
  store: RunStore<CueLineRunState>,
  job: StoredJob,
  claim: CallerWorkClaim,
  home: string,
  now: Date,
): Promise<never> {
  const reason = await persistStartedClaimAmbiguous(store, job, claim, home, now);
  await store.snapshot();
  throw new CueLineError("CALLER_WORK_BECAME_AMBIGUOUS", reason, {
    details: { run_id: store.runId, job_id: job.jobId, claim_id: claim.claimId },
  });
}

async function persistStartedClaimAmbiguous(
  store: RunStore<CueLineRunState>,
  job: StoredJob,
  claim: CallerWorkClaim,
  home: string,
  now: Date,
): Promise<string> {
  const reason =
    "Caller work claim expired after local work started; side effects cannot be inferred or retried.";
  await store.append("caller_work_became_ambiguous", {
    job_id: job.jobId,
    claim_id: claim.claimId,
    fencing_token: claim.fencingToken,
    caller_id: claim.callerId,
    reason,
    detected_at: now.toISOString(),
  });
  await writeClaimJobStatus(home, store, job, "ambiguous", now.toISOString(), reason);
  return reason;
}

async function releaseExpiredUnstartedClaim(
  store: RunStore<CueLineRunState>,
  job: StoredJob,
  claim: CallerWorkClaim,
  home: string,
  now: Date,
  reason = "expired_before_start",
): Promise<void> {
  await store.append("caller_work_claim_released", {
    job_id: job.jobId,
    claim_id: claim.claimId,
    fencing_token: claim.fencingToken,
    caller_id: claim.callerId,
    reason,
    released_at: now.toISOString(),
  });
  await writeClaimJobStatus(home, store, job, "pending", now.toISOString());
}

async function assertClaimNotExpired(
  store: RunStore<CueLineRunState>,
  job: StoredJob,
  claim: CallerWorkClaim,
  home: string,
  now: Date,
): Promise<void> {
  assertClaimClockMonotonic(claim, now);
  if (!claimExpired(claim, now)) return;
  if (claim.startedAt !== null) {
    await markStartedClaimAmbiguous(store, job, claim, home, now);
  }
  await releaseExpiredUnstartedClaim(store, job, claim, home, now);
  await store.snapshot();
  throw new CueLineError(
    "CALLER_WORK_CLAIM_EXPIRED",
    `Caller work claim '${claim.claimId}' expired before local work started.`,
    { details: { run_id: store.runId, job_id: job.jobId, claim_id: claim.claimId } },
  );
}

function exactClaim(job: StoredJob, proof: CueLineCallerWorkClaimProof): CallerWorkClaim {
  assertClaimProof(proof);
  const claim = job.callerWork?.claim;
  if (
    !claim ||
    claim.claimId !== proof.claimId ||
    claim.callerId !== proof.callerId ||
    claim.fencingToken !== proof.fencingToken ||
    claim.taskHash !== jobSpecHash(job.spec) ||
    claim.workdir !== job.spec.workdir
  ) {
    throw new CueLineError(
      "CALLER_WORK_CLAIM_MISMATCH",
      `Caller work proof does not match the active immutable claim for job '${job.jobId}'.`,
    );
  }
  return claim;
}

function claimResult(
  runId: string,
  job: StoredJob,
  claim: CallerWorkClaim,
  outcome: CueLineCallerWorkClaimResult["outcome"],
): CueLineCallerWorkClaimResult {
  return {
    runId,
    jobId: job.jobId,
    outcome,
    task: job.spec.task,
    taskHash: claim.taskHash,
    workdir: claim.workdir,
    resolvedWorkdir: claim.workdirIdentity?.resolvedPath ?? claim.workdir,
    claimId: claim.claimId,
    callerId: claim.callerId,
    fencingToken: claim.fencingToken,
    claimedAt: claim.claimedAt,
    heartbeatAt: claim.heartbeatAt,
    expiresAt: claim.expiresAt,
    started: claim.startedAt !== null,
    startedAt: claim.startedAt,
    ...(claim.lastProgressAt === undefined
      ? {}
      : { lastProgressAt: claim.lastProgressAt }),
  };
}

async function withCallerWorkStore<Result>(
  runId: string,
  options: Pick<CallerWorkMutationOptions, "home" | "environment" | "now">,
  operation: (
    store: RunStore<CueLineRunState>,
    home: string,
    now: () => Date,
  ) => Promise<Result>,
): Promise<Result> {
  const environment = options.environment ?? runtimeEnvironment();
  const home = options.home ?? defaultCueLineHome(environment);
  const now = options.now ?? (() => new Date());
  await loadPersistedRunStore(home, runId);
  const runtime = await readRuntimeLease(home, runId, { now });
  const retiredOwner =
    (runtime.ownership === "active" || runtime.ownership === "stale") &&
    runtime.ownerId !== undefined &&
    (await retireDeadRuntimeLease(home, runId, runtime.ownerId))
      ? { ownerId: runtime.ownerId, ownership: runtime.ownership }
      : undefined;
  const lease = await RuntimeLease.claim({ home, runId, now });
  try {
    const store = await loadPersistedRunStore(home, runId);
    store.bindRuntimeOwner(lease.ownerId);
    if (retiredOwner !== undefined) {
      await store.append("runtime_dead_owner_retired", {
        owner_id: retiredOwner.ownerId,
        previous_ownership: retiredOwner.ownership,
      });
    }
    return await operation(store, home, now);
  } finally {
    await lease.release();
  }
}

export async function claimCueLineCallerJob(
  runId: string,
  jobId: string,
  options: CueLineCallerWorkClaimOptions,
): Promise<CueLineCallerWorkClaimResult> {
  assertCallerId(options.callerId);
  const ttlMs = validatedTtlMs(options.ttlMs);
  return withCallerWorkStore(runId, options, async (store, home, now) => {
    let job = callerWorkJob(store, jobId);
    if (job.status !== "pending" && job.status !== "running") {
      throw new CueLineError(
        "CALLER_WORK_NOT_CLAIMABLE",
        `Caller work job '${jobId}' has status '${job.status}' and cannot be claimed.`,
      );
    }
    const currentTime = now();
    const existing = job.callerWork?.claim;
    if (existing !== null && existing !== undefined) {
      if (!claimExpired(existing, currentTime)) {
        if (existing.callerId === options.callerId) {
          if (existing.workdirIdentity !== undefined || existing.startedAt !== null) {
            return claimResult(runId, job, existing, "already_claimed");
          }
          await releaseExpiredUnstartedClaim(
            store,
            job,
            existing,
            home,
            currentTime,
            "identity_upgrade_before_start",
          );
          job = callerWorkJob(store, jobId);
        } else {
          throw new CueLineError(
            "CALLER_WORK_ALREADY_CLAIMED",
            `Caller work job '${jobId}' already has an active claim.`,
            { details: { job_id: jobId, expires_at: existing.expiresAt } },
          );
        }
      } else {
        if (existing.startedAt !== null) {
          await markStartedClaimAmbiguous(store, job, existing, home, currentTime);
        }
        await releaseExpiredUnstartedClaim(store, job, existing, home, currentTime);
        job = callerWorkJob(store, jobId);
      }
    }
    if (job.status !== "pending") {
      throw new CueLineError(
        "CALLER_WORK_CLAIM_STATE_INVALID",
        `Caller work job '${jobId}' is running without an active claim and cannot be reclaimed safely.`,
      );
    }
    const workdir = job.spec.workdir!;
    const workdirIdentity = await inspectWorkdir(workdir);
    const timestamp = currentTime.toISOString();
    const fencingToken = (job.callerWork?.nextFencingToken ?? 0) + 1;
    const claim: CallerWorkClaim = {
      claimId: `claim_${randomUUID()}`,
      callerId: options.callerId,
      taskHash: jobSpecHash(job.spec),
      workdir,
      workdirIdentity,
      fencingToken,
      claimedAt: timestamp,
      heartbeatAt: timestamp,
      expiresAt: expiration(currentTime, ttlMs),
      ttlMs,
      startedAt: null,
    };
    await store.append("caller_work_claimed", {
      job_id: job.jobId,
      claim,
    });
    await writeClaimJobStatus(home, store, job, "pending", timestamp);
    await store.snapshot();
    return claimResult(runId, job, claim, "claimed");
  });
}

export async function startCueLineCallerJob(
  runId: string,
  jobId: string,
  proof: CueLineCallerWorkClaimProof,
  options: CallerWorkMutationOptions = {},
): Promise<CueLineCallerWorkMutationResult> {
  return withCallerWorkStore(runId, options, async (store, home, now) => {
    const job = callerWorkJob(store, jobId);
    const claim = exactClaim(job, proof);
    if (job.status !== "pending" && job.status !== "running") {
      throw new CueLineError(
        "CALLER_WORK_NOT_STARTABLE",
        `Caller work job '${jobId}' has terminal status '${job.status}'.`,
      );
    }
    const currentTime = now();
    await assertClaimNotExpired(store, job, claim, home, currentTime);
    if (claim.startedAt !== null) {
      return {
        runId,
        jobId,
        claimId: claim.claimId,
        fencingToken: claim.fencingToken,
        outcome: "already_started",
        heartbeatAt: claim.heartbeatAt,
        expiresAt: claim.expiresAt,
        observedAt: currentTime.toISOString(),
        ...(claim.startedAt === null ? {} : { startedAt: claim.startedAt }),
        ...(claim.lastProgressAt === undefined
          ? {}
          : { progressAt: claim.lastProgressAt }),
      };
    }
    await assertClaimedWorkdir(claim);
    const timestamp = currentTime.toISOString();
    const expiresAt = expiration(currentTime, claim.ttlMs);
    await store.append("caller_work_started", {
      job_id: jobId,
      claim_id: claim.claimId,
      caller_id: claim.callerId,
      fencing_token: claim.fencingToken,
      task_hash: claim.taskHash,
      workdir: claim.workdir,
      ...(claim.workdirIdentity === undefined
        ? {}
        : { workdir_identity: claim.workdirIdentity }),
      started_at: timestamp,
      expires_at: expiresAt,
    });
    await writeClaimJobStatus(home, store, job, "running", timestamp, undefined, {
      phase: "caller_work_started",
      lastProgressAt: timestamp,
    });
    await store.snapshot();
    return {
      runId,
      jobId,
      claimId: claim.claimId,
      fencingToken: claim.fencingToken,
      outcome: "started",
      heartbeatAt: timestamp,
      expiresAt,
      observedAt: timestamp,
      startedAt: timestamp,
      progressAt: timestamp,
    };
  });
}

export async function heartbeatCueLineCallerJob(
  runId: string,
  jobId: string,
  proof: CueLineCallerWorkClaimProof,
  options: CallerWorkMutationOptions = {},
): Promise<CueLineCallerWorkMutationResult> {
  return withCallerWorkStore(runId, options, async (store, home, now) => {
    const job = callerWorkJob(store, jobId);
    const claim = exactClaim(job, proof);
    if (job.status !== "pending" && job.status !== "running") {
      throw new CueLineError(
        "CALLER_WORK_NOT_ACTIVE",
        `Caller work job '${jobId}' has terminal status '${job.status}'.`,
      );
    }
    const currentTime = now();
    await assertClaimNotExpired(store, job, claim, home, currentTime);
    const timestamp = currentTime.toISOString();
    const expiresAt = expiration(currentTime, claim.ttlMs);
    await store.append("caller_work_heartbeat", {
      job_id: jobId,
      claim_id: claim.claimId,
      caller_id: claim.callerId,
      fencing_token: claim.fencingToken,
      heartbeat_at: timestamp,
      expires_at: expiresAt,
    });
    await writeClaimJobStatus(
      home,
      store,
      job,
      claim.startedAt === null ? "pending" : "running",
      timestamp,
    );
    await store.snapshot();
    return {
      runId,
      jobId,
      claimId: claim.claimId,
      fencingToken: claim.fencingToken,
      outcome: "heartbeat_recorded",
      heartbeatAt: timestamp,
      expiresAt,
      observedAt: timestamp,
      ...(claim.startedAt === null ? {} : { startedAt: claim.startedAt }),
      ...(claim.lastProgressAt === undefined
        ? {}
        : { progressAt: claim.lastProgressAt }),
    };
  });
}

export async function recordCueLineCallerJobProgress(
  runId: string,
  jobId: string,
  proof: CueLineCallerWorkClaimProof,
  input: CueLineCallerWorkProgressInput,
  options: CallerWorkMutationOptions = {},
): Promise<CueLineCallerWorkMutationResult> {
  assertProgressInput(input);
  return withCallerWorkStore(runId, options, async (store, home, now) => {
    const job = callerWorkJob(store, jobId);
    const claim = exactClaim(job, proof);
    if (job.status !== "running" || claim.startedAt === null) {
      throw new CueLineError(
        "CALLER_WORK_NOT_STARTED",
        `Caller work job '${jobId}' must be durably started before recording progress.`,
      );
    }
    const currentTime = now();
    await assertClaimNotExpired(store, job, claim, home, currentTime);
    const prior = priorProgressEvidence(
      await readAuthoritativeRunEvents(home, runId),
      jobId,
      claim.claimId,
      input.evidenceHash,
    );
    if (prior !== undefined) {
      return {
        runId,
        jobId,
        claimId: claim.claimId,
        fencingToken: claim.fencingToken,
        outcome: "progress_already_recorded",
        heartbeatAt: claim.heartbeatAt,
        expiresAt: claim.expiresAt,
        progressAt: prior.progressAt,
        progressKind: prior.progressKind,
        progressEvidenceHash: input.evidenceHash,
      };
    }
    const timestamp = currentTime.toISOString();
    const expiresAt = expiration(currentTime, claim.ttlMs);
    await store.append("caller_work_progress", {
      job_id: jobId,
      claim_id: claim.claimId,
      caller_id: claim.callerId,
      fencing_token: claim.fencingToken,
      progress_at: timestamp,
      progress_kind: input.kind,
      progress_evidence_hash: input.evidenceHash,
      expires_at: expiresAt,
    });
    await writeClaimJobStatus(home, store, job, "running", timestamp, undefined, {
      phase: input.kind,
      lastProgressAt: timestamp,
    });
    await store.snapshot();
    return {
      runId,
      jobId,
      claimId: claim.claimId,
      fencingToken: claim.fencingToken,
      outcome: "progress_recorded",
      heartbeatAt: timestamp,
      expiresAt,
      progressAt: timestamp,
      progressKind: input.kind,
      progressEvidenceHash: input.evidenceHash,
    };
  });
}

/** Internal executor safety transition used before aborting a timed-out lease. */
export async function requireCueLineCallerJobReview(
  runId: string,
  jobId: string,
  proof: CueLineCallerWorkClaimProof,
  input: CallerWorkReviewInput,
  options: CallerWorkMutationOptions = {},
): Promise<boolean> {
  if (
    (input.reasonCode !== "progress_stalled" &&
      input.reasonCode !== "max_execution_elapsed") ||
    input.reason.trim() === "" ||
    input.reason.length > 1_024 ||
    !Number.isSafeInteger(input.limitMs) ||
    input.limitMs < 1
  ) {
    throw new CueLineError(
      "CALLER_WORK_REVIEW_INVALID",
      "Caller work review requires a supported reason, bounded message, and positive limitMs.",
    );
  }
  return withCallerWorkStore(runId, options, async (store, home, now) => {
    const job = callerWorkJob(store, jobId);
    const claim = exactClaim(job, proof);
    if (job.status !== "pending" && job.status !== "running") return false;
    if (job.status !== "running" || claim.startedAt === null) {
      throw new CueLineError(
        "CALLER_WORK_NOT_STARTED",
        `Caller work job '${jobId}' must be durably started before controller review.`,
      );
    }
    const currentTime = now();
    await assertClaimNotExpired(store, job, claim, home, currentTime);
    const timestamp = currentTime.toISOString();
    await store.append("caller_work_review_required", {
      job_id: jobId,
      claim_id: claim.claimId,
      caller_id: claim.callerId,
      fencing_token: claim.fencingToken,
      reason_code: input.reasonCode,
      reason: input.reason,
      limit_ms: input.limitMs,
      requested_at: timestamp,
      last_progress_at: claim.lastProgressAt ?? claim.startedAt,
    });
    await writeClaimJobStatus(home, store, job, "ambiguous", timestamp, input.reason);
    await store.snapshot();
    return true;
  });
}

export async function releaseCueLineCallerJob(
  runId: string,
  jobId: string,
  proof: CueLineCallerWorkClaimProof,
  options: CallerWorkMutationOptions = {},
): Promise<CueLineCallerWorkMutationResult> {
  return withCallerWorkStore(runId, options, async (store, home, now) => {
    const job = callerWorkJob(store, jobId);
    const claim = exactClaim(job, proof);
    const currentTime = now();
    await assertClaimNotExpired(store, job, claim, home, currentTime);
    if (claim.startedAt !== null) {
      throw new CueLineError(
        "CALLER_WORK_RELEASE_AFTER_START_FORBIDDEN",
        "A caller work claim cannot be released after local work started; submit a terminal result or let it become ambiguous.",
      );
    }
    await store.append("caller_work_claim_released", {
      job_id: jobId,
      claim_id: claim.claimId,
      caller_id: claim.callerId,
      fencing_token: claim.fencingToken,
      reason: "caller_released_before_start",
      released_at: currentTime.toISOString(),
    });
    await writeClaimJobStatus(home, store, job, "pending", currentTime.toISOString());
    await store.snapshot();
    return {
      runId,
      jobId,
      claimId: claim.claimId,
      fencingToken: claim.fencingToken,
      outcome: "released",
    };
  });
}

/** Internal continuation repair: settle only claims whose durable TTL has elapsed. */
export async function reconcileExpiredCallerWorkClaims(
  runId: string,
  options: CallerWorkMutationOptions = {},
): Promise<number> {
  return withCallerWorkStore(runId, options, async (store, home, now) => {
    if (store.state.executor !== "caller") return 0;
    const currentTime = now();
    let affected = 0;
    for (const job of Object.values(store.state.jobs)) {
      const claim = job.callerWork?.claim;
      if (
        job.spec.mode !== "work" ||
        (job.status !== "pending" && job.status !== "running") ||
        claim === null ||
        claim === undefined ||
        !claimExpired(claim, currentTime)
      ) {
        continue;
      }
      if (claim.startedAt === null) {
        await releaseExpiredUnstartedClaim(store, job, claim, home, currentTime);
      } else {
        await persistStartedClaimAmbiguous(store, job, claim, home, currentTime);
      }
      affected += 1;
    }
    if (affected > 0) await store.snapshot();
    return affected;
  });
}

/** Internal validation used while submitCueLineCallerJobResult owns the run lease. */
export async function validateCallerWorkResultClaim(
  store: RunStore<CueLineRunState>,
  job: StoredJob,
  proof: CueLineCallerWorkClaimProof,
  home: string,
  now: Date,
  options: { durableTerminalIntent?: boolean } = {},
): Promise<{ claim: CallerWorkClaim; alreadyTerminal: boolean }> {
  const claim = exactClaim(job, proof);
  const alreadyTerminal = job.status !== "pending" && job.status !== "running";
  if (alreadyTerminal) return { claim, alreadyTerminal };
  if (options.durableTerminalIntent === true) {
    if (claim.startedAt === null || job.status !== "running") {
      throw new CueLineError(
        "CALLER_WORK_NOT_STARTED",
        `Caller work job '${job.jobId}' must be durably started before recovering a terminal result.`,
      );
    }
    return { claim, alreadyTerminal: false };
  }
  await assertClaimNotExpired(store, job, claim, home, now);
  if (claim.startedAt === null || job.status !== "running") {
    throw new CueLineError(
      "CALLER_WORK_NOT_STARTED",
      `Caller work job '${job.jobId}' must be durably started before submitting a result.`,
    );
  }
  return { claim, alreadyTerminal: false };
}
