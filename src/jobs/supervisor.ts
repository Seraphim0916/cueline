import { CueLineError } from "../core/errors.js";
import { executionFor, type JobResult, type RunnerAdapter, type RunnerSpec } from "../runners/runner-adapter.js";
import { JobLocks } from "./locks.js";
import { JobStatusStore, type JobStatus } from "./status.js";

export interface JobSupervisorOptions {
  statusStore: JobStatusStore;
  locks?: JobLocks;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Starts each job at most once. A background call returns its persisted
 * running status; foreground calls wait for that exact same execution.
 */
export class JobSupervisor {
  readonly #locks: JobLocks;
  readonly #completions = new Map<string, Promise<JobStatus>>();
  readonly #cancellations = new Map<string, AbortController>();

  constructor(
    private readonly runner: RunnerAdapter,
    private readonly options: JobSupervisorOptions,
  ) {
    this.#locks = options.locks ?? new JobLocks();
  }

  async start(spec: RunnerSpec): Promise<JobStatus> {
    const lock = this.#locks.acquire(spec.jobId);
    const startedAt = new Date().toISOString();
    const running = { current: {
      jobId: spec.jobId,
      ...(spec.runId === undefined ? {} : { runId: spec.runId }),
      ...(spec.jobKey === undefined ? {} : { jobKey: spec.jobKey }),
      ...(spec.lane === undefined ? {} : { lane: spec.lane }),
      ...(spec.runnerId === undefined ? {} : { runnerId: spec.runnerId }),
      mode: spec.mode,
      execution: executionFor(spec),
      status: "running",
      phase: "starting",
      lastProgressAt: startedAt,
      startedAt,
    } satisfies JobStatus };
    const cancellation = new AbortController();
    this.#cancellations.set(spec.jobId, cancellation);
    const signal =
      spec.signal === undefined
        ? cancellation.signal
        : AbortSignal.any([spec.signal, cancellation.signal]);

    try {
      await this.options.statusStore.write(running.current);
    } catch (error) {
      this.#cancellations.delete(spec.jobId);
      lock.release();
      throw error;
    }

    const completion = this.completeOnce({ ...spec, signal }, running, lock.release);
    this.#completions.set(spec.jobId, completion);

    if (spec.background === true) {
      void completion.catch(() => undefined);
      return running.current;
    }
    return completion;
  }

  cancel(jobId: string): boolean {
    const cancellation = this.#cancellations.get(jobId);
    if (cancellation === undefined || cancellation.signal.aborted) return false;
    cancellation.abort();
    return true;
  }

  cancelAll(): number {
    let count = 0;
    for (const jobId of this.#cancellations.keys()) {
      if (this.cancel(jobId)) count += 1;
    }
    return count;
  }

  async waitForCompletion(jobId: string): Promise<JobStatus> {
    const completion = this.#completions.get(jobId);
    if (completion !== undefined) {
      return completion;
    }

    const persisted = await this.options.statusStore.read(jobId);
    if (persisted !== undefined) {
      return persisted;
    }
    throw new CueLineError("JOB_NOT_FOUND", `no job status exists for: ${jobId}`, { details: { jobId } });
  }

  async inspect(jobId: string): Promise<JobStatus> {
    const persisted = await this.options.statusStore.read(jobId);
    if (persisted !== undefined) return persisted;
    throw new CueLineError("JOB_NOT_FOUND", `no job status exists for: ${jobId}`, {
      details: { jobId },
    });
  }

  private async completeOnce(
    spec: RunnerSpec,
    running: { current: JobStatus },
    release: () => void,
  ): Promise<JobStatus> {
    let terminal: JobStatus;
    let progressWrites = Promise.resolve();
    const persistProgress = (
      update: Partial<Pick<JobStatus, "pid" | "model" | "provider" | "phase" | "lastProgressAt">>,
    ): Promise<void> => {
      progressWrites = progressWrites.then(async () => {
        running.current = { ...running.current, ...update };
        await this.options.statusStore.write(running.current);
      });
      return progressWrites;
    };
    try {
      const result = await this.runner.run(spec, {
        onSpawn: (pid) =>
          persistProgress({
            pid,
            phase: "running",
            lastProgressAt: new Date().toISOString(),
          }),
        onProgress: (progress) =>
          persistProgress({
            phase: progress.phase,
            lastProgressAt: progress.at,
            ...(progress.model === undefined ? {} : { model: progress.model }),
            ...(progress.provider === undefined ? {} : { provider: progress.provider }),
          }),
      });
      await progressWrites;
      terminal = this.withResult(running.current, result);
    } catch (error) {
      await progressWrites.catch(() => undefined);
      const finishedAt = new Date().toISOString();
      terminal = {
        ...running.current,
        status:
          running.current.pid !== undefined && spec.mode === "work"
            ? "ambiguous"
            : "failed",
        phase: "failed",
        lastProgressAt: finishedAt,
        finishedAt,
        error: errorText(error),
      };
    }

    try {
      await this.options.statusStore.write(terminal);
      return terminal;
    } finally {
      this.#completions.delete(spec.jobId);
      this.#cancellations.delete(spec.jobId);
      release();
    }
  }

  private withResult(running: JobStatus, result: JobResult): JobStatus {
    return {
      ...running,
      status: result.status,
      phase: result.status === "succeeded" ? "completed" : result.status,
      lastProgressAt: result.finishedAt,
      finishedAt: result.finishedAt,
      result,
    };
  }
}
