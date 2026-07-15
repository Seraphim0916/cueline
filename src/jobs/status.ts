import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { CueLineError } from "../core/errors.js";
import { runtimePidTag } from "../core/runtime.js";
import type { JobMode } from "../protocol/types.js";
import type { JobExecution, JobResult, JobResultStatus } from "../runners/runner-adapter.js";

export type JobStatusKind = "pending" | "running" | JobResultStatus;

export interface JobStatus {
  jobId: string;
  runId?: string;
  jobKey?: string;
  lane?: string;
  mode?: JobMode;
  runnerId?: string;
  model?: string;
  provider?: string;
  pid?: number;
  phase?: string;
  lastProgressAt?: string;
  execution: JobExecution;
  status: JobStatusKind;
  startedAt: string;
  finishedAt?: string;
  result?: JobResult;
  error?: string;
}

function assertSafeJobId(jobId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(jobId)) {
    throw new CueLineError("JOB_ID_INVALID", "job id contains unsupported path characters", {
      details: { jobId },
    });
  }
}

/**
 * Stores one atomically replaced JSON status file per job. The write format is
 * deliberately small so foreground and background work share the same view.
 */
export class JobStatusStore {
  readonly #directory: string;

  constructor(rootDirectory: string) {
    this.#directory = path.resolve(rootDirectory, "jobs");
  }

  async write(status: JobStatus): Promise<void> {
    assertSafeJobId(status.jobId);
    await mkdir(this.#directory, { recursive: true });
    const target = this.pathFor(status.jobId);
    const temporary = `${target}.${runtimePidTag()}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(status)}\n`, "utf8");
    await rename(temporary, target);
  }

  async read(jobId: string): Promise<JobStatus | undefined> {
    assertSafeJobId(jobId);
    try {
      const source = await readFile(this.pathFor(jobId), "utf8");
      return JSON.parse(source) as JobStatus;
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw new CueLineError("JOB_STATUS_READ_FAILED", `unable to read job status: ${jobId}`, {
        cause: error,
        details: { jobId },
      });
    }
  }

  pathFor(jobId: string): string {
    assertSafeJobId(jobId);
    return path.join(this.#directory, `${jobId}.json`);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
