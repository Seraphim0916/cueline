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

  constructor(
    private readonly runner: RunnerAdapter,
    private readonly options: JobSupervisorOptions,
  ) {
    this.#locks = options.locks ?? new JobLocks();
  }

  async start(spec: RunnerSpec): Promise<JobStatus> {
    const lock = this.#locks.acquire(spec.jobId);
    const running: JobStatus = {
      jobId: spec.jobId,
      execution: executionFor(spec),
      status: "running",
      startedAt: new Date().toISOString(),
    };

    try {
      await this.options.statusStore.write(running);
    } catch (error) {
      lock.release();
      throw error;
    }

    const completion = this.completeOnce(spec, running, lock.release);
    this.#completions.set(spec.jobId, completion);

    if (spec.background === true) {
      void completion.catch(() => undefined);
      return running;
    }
    return completion;
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
    running: JobStatus,
    release: () => void,
  ): Promise<JobStatus> {
    let terminal: JobStatus;
    try {
      const result = await this.runner.run(spec);
      terminal = this.withResult(running, result);
    } catch (error) {
      terminal = {
        ...running,
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: errorText(error),
      };
    }

    try {
      await this.options.statusStore.write(terminal);
      return terminal;
    } finally {
      this.#completions.delete(spec.jobId);
      release();
    }
  }

  private withResult(running: JobStatus, result: JobResult): JobStatus {
    return {
      ...running,
      status: result.status,
      finishedAt: result.finishedAt,
      result,
    };
  }
}
