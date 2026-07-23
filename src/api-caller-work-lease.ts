import type {
  CueLineCallerWorkClaimProof,
  CueLineCallerWorkClaimResult,
  CueLineCallerWorkMutationOptions,
  CueLineCallerWorkMutationResult,
  CueLineCallerWorkProgressInput,
} from "./api-contracts.js";
import {
  heartbeatCueLineCallerJob,
  recordCueLineCallerJobProgress,
  requireCueLineCallerJobReview,
  startCueLineCallerJob,
} from "./api-caller-work.js";
import { CueLineError } from "./core/errors.js";
import { validatedTimerDelay } from "./core/timing.js";

export const DEFAULT_CALLER_WORK_HEARTBEAT_INTERVAL_MS = 60_000;
export const DEFAULT_CALLER_WORK_PROGRESS_TIMEOUT_MS = 3_600_000;
export const DEFAULT_CALLER_WORK_MAX_EXECUTION_MS = 86_400_000;

export interface CueLineCallerWorkLeaseOptions
  extends CueLineCallerWorkMutationOptions {
  /** Executor-owned renewal cadence. Must be shorter than the durable claim TTL. */
  heartbeatIntervalMs?: number;
  /** Stop for controller review when no new durable progress is recorded. */
  progressTimeoutMs?: number;
  /** Absolute local bound for this execution scope; this is separate from claim TTL. */
  maxExecutionMs?: number;
  /** Abort the local lease when the owning executor scope is cancelled. */
  signal?: AbortSignal;
}

type CallerWorkLeaseState = "active" | "stopped" | "failed";

function claimProof(claim: CueLineCallerWorkClaimResult): CueLineCallerWorkClaimProof {
  return {
    claimId: claim.claimId,
    callerId: claim.callerId,
    fencingToken: claim.fencingToken,
  };
}

function mutationOptions(
  options: CueLineCallerWorkLeaseOptions,
): CueLineCallerWorkMutationOptions {
  return {
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
}

function validateHeartbeatWindow(
  claim: CueLineCallerWorkClaimResult,
  heartbeatIntervalMs: number,
): void {
  const heartbeatAt = Date.parse(claim.heartbeatAt);
  const expiresAt = Date.parse(claim.expiresAt);
  const claimWindowMs = expiresAt - heartbeatAt;
  if (
    !Number.isFinite(heartbeatAt) ||
    !Number.isFinite(expiresAt) ||
    claimWindowMs <= 0 ||
    heartbeatIntervalMs >= claimWindowMs
  ) {
    throw new CueLineError(
      "CALLER_WORK_HEARTBEAT_INTERVAL_INVALID",
      "Caller work heartbeatIntervalMs must be shorter than the durable claim TTL.",
      {
        details: {
          heartbeat_interval_ms: heartbeatIntervalMs,
          claim_window_ms: claimWindowMs,
        },
      },
    );
  }
}

/**
 * Executor-owned heartbeat scope for one already claimed caller work job.
 * The timer proves only that this local execution scope remains owned; it does
 * not claim that the job is making progress.
 */
export interface CueLineCallerWorkLease {
  readonly runId: string;
  readonly jobId: string;
  readonly proof: CueLineCallerWorkClaimProof;
  readonly heartbeatIntervalMs: number;
  readonly progressTimeoutMs: number;
  readonly maxExecutionMs: number;
  readonly signal: AbortSignal;
  readonly active: boolean;
  readonly failure: unknown;
  assertHealthy(): void;
  heartbeatNow(): Promise<CueLineCallerWorkMutationResult>;
  recordProgress(input: CueLineCallerWorkProgressInput): Promise<CueLineCallerWorkMutationResult>;
  stop(): Promise<void>;
}

class ActiveCueLineCallerWorkLease implements CueLineCallerWorkLease {
  readonly runId: string;
  readonly jobId: string;
  readonly proof: CueLineCallerWorkClaimProof;
  readonly heartbeatIntervalMs: number;
  readonly progressTimeoutMs: number;
  readonly maxExecutionMs: number;
  readonly signal: AbortSignal;

  readonly #options: CueLineCallerWorkMutationOptions;
  readonly #controller = new AbortController();
  readonly #externalSignal: AbortSignal | undefined;
  readonly #externalAbort: () => void;
  #state: CallerWorkLeaseState = "active";
  #failure: unknown = undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #progressTimer: NodeJS.Timeout | undefined;
  #maxExecutionTimer: NodeJS.Timeout | undefined;
  #progressDeadlineAt: number;
  #queuedMutations = 0;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(
    claim: CueLineCallerWorkClaimResult,
    options: CueLineCallerWorkLeaseOptions,
    heartbeatIntervalMs: number,
    progressTimeoutMs: number,
    maxExecutionMs: number,
    progressRemainingMs: number,
    maxExecutionRemainingMs: number,
  ) {
    this.runId = claim.runId;
    this.jobId = claim.jobId;
    this.proof = claimProof(claim);
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.progressTimeoutMs = progressTimeoutMs;
    this.maxExecutionMs = maxExecutionMs;
    this.#progressDeadlineAt = Date.now() + progressRemainingMs;
    this.#options = mutationOptions(options);
    this.#externalSignal = options.signal;
    this.signal = this.#controller.signal;
    this.#externalAbort = () => {
      this.#fail(
        options.signal?.reason ??
          new CueLineError(
            "CALLER_WORK_EXECUTION_ABORTED",
            `Caller work executor scope for '${this.jobId}' was aborted.`,
          ),
      );
    };

    this.#heartbeatTimer = setInterval(() => {
      if (this.#queuedMutations === 0) {
        void this.heartbeatNow().catch(() => undefined);
      }
    }, heartbeatIntervalMs);
    this.#heartbeatTimer.unref();
    this.#armProgressTimer(progressRemainingMs);
    this.#maxExecutionTimer = setTimeout(() => {
      const error = new CueLineError(
        "CALLER_WORK_MAX_EXECUTION_EXCEEDED",
        `Caller work executor scope for '${this.jobId}' exceeded ${maxExecutionMs}ms.`,
        {
          details: {
            run_id: this.runId,
            job_id: this.jobId,
            max_execution_ms: maxExecutionMs,
          },
        },
      );
      this.#requireControllerReview(error, "max_execution_elapsed", maxExecutionMs);
    }, maxExecutionRemainingMs);
    this.#maxExecutionTimer.unref();
    options.signal?.addEventListener("abort", this.#externalAbort, { once: true });
    if (options.signal?.aborted) this.#externalAbort();
  }

  get active(): boolean {
    return this.#state === "active";
  }

  get failure(): unknown {
    return this.#failure;
  }

  assertHealthy(): void {
    if (this.#failure !== undefined) throw this.#failure;
  }

  heartbeatNow(): Promise<CueLineCallerWorkMutationResult> {
    return this.#queueMutation(() =>
      heartbeatCueLineCallerJob(
        this.runId,
        this.jobId,
        this.proof,
        this.#options,
      ),
    );
  }

  recordProgress(
    input: CueLineCallerWorkProgressInput,
  ): Promise<CueLineCallerWorkMutationResult> {
    if (this.#state !== "active") return Promise.reject(this.#inactiveError());
    if (Date.now() >= this.#progressDeadlineAt) {
      const error = this.#progressFailure();
      this.#requireControllerReview(
        error,
        "progress_stalled",
        this.progressTimeoutMs,
      );
      return Promise.reject(error);
    }
    if (this.#progressTimer !== undefined) {
      clearTimeout(this.#progressTimer);
      this.#progressTimer = undefined;
    }
    return this.#queueMutation(() =>
      recordCueLineCallerJobProgress(
        this.runId,
        this.jobId,
        this.proof,
        input,
        this.#options,
      ),
    ).then((result) => {
      if (this.#state !== "active") return result;
      if (result.outcome === "progress_recorded") {
        this.#progressDeadlineAt = Date.now() + this.progressTimeoutMs;
      }
      const remainingMs = this.#progressDeadlineAt - Date.now();
      if (remainingMs <= 0) {
        this.#requireControllerReview(
          this.#progressFailure(),
          "progress_stalled",
          this.progressTimeoutMs,
        );
      } else this.#armProgressTimer(remainingMs);
      return result;
    });
  }

  async stop(): Promise<void> {
    if (this.#state === "active") this.#state = "stopped";
    this.#clearTimers();
    this.#externalSignal?.removeEventListener("abort", this.#externalAbort);
    await this.#mutationTail;
    if (this.#failure !== undefined) this.#abortFailure();
  }

  #queueMutation(
    mutation: () => Promise<CueLineCallerWorkMutationResult>,
  ): Promise<CueLineCallerWorkMutationResult> {
    if (this.#state !== "active") return Promise.reject(this.#inactiveError());
    this.#queuedMutations += 1;
    const operation = this.#mutationTail.then(() => {
      if (this.#state === "failed") throw this.#inactiveError();
      return mutation();
    });
    const guarded = operation
      .catch((error: unknown) => {
        this.#fail(error);
        throw error;
      })
      .finally(() => {
        this.#queuedMutations -= 1;
      });
    this.#mutationTail = guarded.then(
      () => undefined,
      () => undefined,
    );
    return guarded;
  }

  #inactiveError(): unknown {
    return (
      this.#failure ??
      new CueLineError(
        "CALLER_WORK_LEASE_NOT_ACTIVE",
        `Caller work executor lease for '${this.jobId}' is not active.`,
      )
    );
  }

  #progressFailure(): CueLineError {
    return new CueLineError(
      "CALLER_WORK_PROGRESS_REVIEW_REQUIRED",
      `Caller work executor scope for '${this.jobId}' recorded no new progress for ${this.progressTimeoutMs}ms and requires controller review.`,
      {
        details: {
          run_id: this.runId,
          job_id: this.jobId,
          progress_timeout_ms: this.progressTimeoutMs,
        },
      },
    );
  }

  #armProgressTimer(delayMs = this.progressTimeoutMs): void {
    if (this.#progressTimer !== undefined) clearTimeout(this.#progressTimer);
    this.#progressTimer = setTimeout(() => {
      this.#progressTimer = undefined;
      const remainingMs = this.#progressDeadlineAt - Date.now();
      if (remainingMs > 0) {
        this.#armProgressTimer(remainingMs);
        return;
      }
      this.#requireControllerReview(
        this.#progressFailure(),
        "progress_stalled",
        this.progressTimeoutMs,
      );
    }, delayMs);
    this.#progressTimer.unref();
  }

  #clearTimers(): void {
    if (this.#heartbeatTimer !== undefined) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
    if (this.#progressTimer !== undefined) {
      clearTimeout(this.#progressTimer);
      this.#progressTimer = undefined;
    }
    if (this.#maxExecutionTimer !== undefined) {
      clearTimeout(this.#maxExecutionTimer);
      this.#maxExecutionTimer = undefined;
    }
  }

  #fail(error: unknown): void {
    if (this.#failure === undefined) this.#failure = error;
    if (this.#state === "active") this.#state = "failed";
    this.#clearTimers();
    this.#externalSignal?.removeEventListener("abort", this.#externalAbort);
    // Quiesce an already-started durable renewal before aborting the executor
    // signal. This guarantees that no heartbeat can be persisted after callers
    // observe the abort, while still preventing any new renewal from starting.
    void this.#mutationTail.finally(() => this.#abortFailure());
  }

  #requireControllerReview(
    error: CueLineError,
    reasonCode: "progress_stalled" | "max_execution_elapsed",
    limitMs: number,
  ): void {
    if (this.#failure !== undefined) return;
    this.#failure = error;
    this.#state = "failed";
    this.#clearTimers();
    this.#externalSignal?.removeEventListener("abort", this.#externalAbort);
    const reason = error.message;
    const review = this.#mutationTail.then(() =>
      requireCueLineCallerJobReview(
        this.runId,
        this.jobId,
        this.proof,
        { reasonCode, reason, limitMs },
        this.#options,
      ),
    );
    this.#mutationTail = review.then(
      () => undefined,
      () => undefined,
    );
    void this.#mutationTail.then(() => this.#abortFailure());
  }

  #abortFailure(): void {
    if (!this.#controller.signal.aborted) this.#controller.abort(this.#failure);
  }
}

/**
 * Durably starts one claimed work job, then keeps its claim alive from the
 * caller executor process until stop, abort, heartbeat failure, or hard limit.
 */
export async function startCueLineCallerWorkLease(
  claim: CueLineCallerWorkClaimResult,
  options: CueLineCallerWorkLeaseOptions = {},
): Promise<CueLineCallerWorkLease> {
  if (options.signal?.aborted) {
    throw new CueLineError(
      "CALLER_WORK_EXECUTION_ABORTED",
      `Caller work executor scope for '${claim.jobId}' was already aborted.`,
      { cause: options.signal.reason },
    );
  }
  const heartbeatIntervalMs = validatedTimerDelay(
    options.heartbeatIntervalMs ?? DEFAULT_CALLER_WORK_HEARTBEAT_INTERVAL_MS,
    {
      code: "CALLER_WORK_HEARTBEAT_INTERVAL_INVALID",
      name: "caller work heartbeatIntervalMs",
    },
  );
  const maxExecutionMs = validatedTimerDelay(
    options.maxExecutionMs ?? DEFAULT_CALLER_WORK_MAX_EXECUTION_MS,
    {
      code: "CALLER_WORK_MAX_EXECUTION_INVALID",
      name: "caller work maxExecutionMs",
    },
  );
  const progressTimeoutMs = validatedTimerDelay(
    options.progressTimeoutMs ?? DEFAULT_CALLER_WORK_PROGRESS_TIMEOUT_MS,
    {
      code: "CALLER_WORK_PROGRESS_TIMEOUT_INVALID",
      name: "caller work progressTimeoutMs",
    },
  );
  validateHeartbeatWindow(claim, heartbeatIntervalMs);
  const started = await startCueLineCallerJob(
    claim.runId,
    claim.jobId,
    claimProof(claim),
    mutationOptions(options),
  );
  const startedAt = started.startedAt;
  const progressAt = started.progressAt ?? startedAt;
  const startedAtMs = startedAt === undefined ? Number.NaN : Date.parse(startedAt);
  const progressAtMs = progressAt === undefined ? Number.NaN : Date.parse(progressAt);
  if (
    !Number.isFinite(startedAtMs) ||
    !Number.isFinite(progressAtMs) ||
    progressAtMs < startedAtMs
  ) {
    throw new CueLineError(
      "CALLER_WORK_LEASE_ANCHOR_INVALID",
      `Caller work executor lease for '${claim.jobId}' lacks monotonic durable timing anchors.`,
    );
  }
  const progressDueAtMs = progressAtMs + progressTimeoutMs;
  const maxExecutionDueAtMs = startedAtMs + maxExecutionMs;
  const assertDeadlineAvailable = async (
    currentAt: string | undefined,
  ): Promise<number> => {
    const currentAtMs = currentAt === undefined ? Number.NaN : Date.parse(currentAt);
    if (!Number.isFinite(currentAtMs) || currentAtMs < progressAtMs) {
      throw new CueLineError(
        "CALLER_WORK_LEASE_ANCHOR_INVALID",
        `Caller work executor lease for '${claim.jobId}' lacks monotonic durable timing anchors.`,
      );
    }
    if (progressDueAtMs <= currentAtMs || maxExecutionDueAtMs <= currentAtMs) {
      const maxElapsedFirst = maxExecutionDueAtMs <= progressDueAtMs;
      const error = maxElapsedFirst
        ? new CueLineError(
            "CALLER_WORK_MAX_EXECUTION_EXCEEDED",
            `Caller work executor scope for '${claim.jobId}' exceeded ${maxExecutionMs}ms.`,
            {
              details: {
                run_id: claim.runId,
                job_id: claim.jobId,
                max_execution_ms: maxExecutionMs,
              },
            },
          )
        : new CueLineError(
            "CALLER_WORK_PROGRESS_REVIEW_REQUIRED",
            `Caller work executor scope for '${claim.jobId}' recorded no new progress for ${progressTimeoutMs}ms and requires controller review.`,
            {
              details: {
                run_id: claim.runId,
                job_id: claim.jobId,
                progress_timeout_ms: progressTimeoutMs,
              },
            },
          );
      await requireCueLineCallerJobReview(
        claim.runId,
        claim.jobId,
        claimProof(claim),
        {
          reasonCode: maxElapsedFirst
            ? "max_execution_elapsed"
            : "progress_stalled",
          reason: error.message,
          limitMs: maxElapsedFirst ? maxExecutionMs : progressTimeoutMs,
        },
        mutationOptions(options),
      );
      throw error;
    }
    return currentAtMs;
  };
  let currentAtMs = await assertDeadlineAvailable(
    started.observedAt ?? started.heartbeatAt,
  );
  if (started.outcome === "already_started") {
    const renewed = await heartbeatCueLineCallerJob(
      claim.runId,
      claim.jobId,
      claimProof(claim),
      mutationOptions(options),
    );
    currentAtMs = await assertDeadlineAvailable(
      renewed.observedAt ?? renewed.heartbeatAt,
    );
  }
  return new ActiveCueLineCallerWorkLease(
    claim,
    options,
    heartbeatIntervalMs,
    progressTimeoutMs,
    maxExecutionMs,
    progressDueAtMs - currentAtMs,
    maxExecutionDueAtMs - currentAtMs,
  );
}
