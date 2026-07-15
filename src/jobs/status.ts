import { readFile } from "node:fs/promises";
import path from "node:path";

import { CueLineError } from "../core/errors.js";
import { canonicalJson } from "../core/ids.js";
import type { JobMode } from "../protocol/types.js";
import type { JobExecution, JobResult, JobResultStatus } from "../runners/runner-adapter.js";
import { atomicCreateJson, atomicWriteJson } from "../state/atomic-write.js";

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

function isTerminalStatus(status: JobStatus): boolean {
  return status.status !== "pending" && status.status !== "running";
}

/**
 * Stores one replaceable JSON status plus an immutable anchor for the first
 * terminal result. Readers prefer the anchor, preventing stale writers from
 * regressing completed work or authorizing a duplicate spawn.
 */
export class JobStatusStore {
  readonly #directory: string;

  constructor(rootDirectory: string) {
    this.#directory = path.resolve(rootDirectory, "jobs");
  }

  async write(status: JobStatus): Promise<void> {
    assertSafeJobId(status.jobId);
    const jsonStatus = JSON.parse(JSON.stringify(status)) as JobStatus;
    const existingTerminal = await this.#anchorLegacyTerminal(status.jobId);
    if (isTerminalStatus(jsonStatus)) {
      let committed = existingTerminal;
      if (committed === undefined) {
        const created = await atomicCreateJson(
          this.terminalPathFor(status.jobId),
          jsonStatus,
        );
        committed = created ? jsonStatus : await this.#readTerminal(status.jobId);
      }
      if (committed === undefined) {
        throw new CueLineError(
          "JOB_STATUS_TERMINAL_WRITE_FAILED",
          `Terminal job status disappeared while being committed: ${status.jobId}`,
        );
      }
      if (canonicalJson(committed) !== canonicalJson(jsonStatus)) {
        throw new CueLineError(
          "JOB_STATUS_TERMINAL_CONFLICT",
          `Job '${status.jobId}' already has different terminal execution evidence.`,
          {
            details: {
              jobId: status.jobId,
              committedStatus: committed.status,
              rejectedStatus: jsonStatus.status,
            },
          },
        );
      }
      await atomicWriteJson(this.pathFor(status.jobId), committed);
      return;
    }

    if (existingTerminal !== undefined) {
      await atomicWriteJson(this.pathFor(status.jobId), existingTerminal);
      throw this.#alreadyTerminalError(status.jobId, existingTerminal.status);
    }
    await atomicWriteJson(this.pathFor(status.jobId), jsonStatus);
    const concurrentTerminal = await this.#readTerminal(status.jobId);
    if (concurrentTerminal !== undefined) {
      await atomicWriteJson(this.pathFor(status.jobId), concurrentTerminal);
      throw this.#alreadyTerminalError(status.jobId, concurrentTerminal.status);
    }
  }

  async read(jobId: string): Promise<JobStatus | undefined> {
    assertSafeJobId(jobId);
    const terminal = await this.#readTerminal(jobId);
    if (terminal !== undefined) return terminal;
    return this.#readPath(this.pathFor(jobId), jobId);
  }

  async #anchorLegacyTerminal(jobId: string): Promise<JobStatus | undefined> {
    const anchored = await this.#readTerminal(jobId);
    if (anchored !== undefined) return anchored;
    const current = await this.#readPath(this.pathFor(jobId), jobId);
    if (current === undefined || !isTerminalStatus(current)) return undefined;
    const created = await atomicCreateJson(this.terminalPathFor(jobId), current);
    if (created) return current;
    return this.#readTerminal(jobId);
  }

  async #readTerminal(jobId: string): Promise<JobStatus | undefined> {
    const status = await this.#readPath(this.terminalPathFor(jobId), jobId);
    if (status !== undefined && !isTerminalStatus(status)) {
      throw new CueLineError(
        "JOB_STATUS_TERMINAL_INVALID",
        `Terminal anchor for job '${jobId}' contains a non-terminal status.`,
      );
    }
    return status;
  }

  async #readPath(target: string, jobId: string): Promise<JobStatus | undefined> {
    try {
      const source = await readFile(target, "utf8");
      const status = JSON.parse(source) as JobStatus;
      if (status.jobId !== jobId) {
        throw new CueLineError(
          "JOB_STATUS_IDENTITY_MISMATCH",
          `Persisted status identity does not match requested job '${jobId}'.`,
          { details: { jobId, persistedJobId: status.jobId } },
        );
      }
      return status;
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      if (error instanceof CueLineError) throw error;
      throw new CueLineError("JOB_STATUS_READ_FAILED", `unable to read job status: ${jobId}`, {
        cause: error,
        details: { jobId },
      });
    }
  }

  #alreadyTerminalError(jobId: string, committedStatus: JobStatusKind): CueLineError {
    return new CueLineError(
      "JOB_STATUS_ALREADY_TERMINAL",
      `Job '${jobId}' already has terminal status '${committedStatus}'; refusing a non-terminal update.`,
      { details: { jobId, committedStatus } },
    );
  }

  pathFor(jobId: string): string {
    assertSafeJobId(jobId);
    return path.join(this.#directory, `${jobId}.json`);
  }

  terminalPathFor(jobId: string): string {
    assertSafeJobId(jobId);
    return path.join(this.#directory, `${jobId}.terminal`);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
