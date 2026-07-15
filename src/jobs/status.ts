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

const JOB_STATUS_KINDS = new Set<JobStatusKind>([
  "pending",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "ambiguous",
]);

const JOB_RESULT_STATUSES = new Set<JobResultStatus>([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "ambiguous",
]);

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function validJobResult(value: unknown, expectedStatus: JobStatusKind): value is JobResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.status === "string" &&
    JOB_RESULT_STATUSES.has(result.status as JobResultStatus) &&
    result.status === expectedStatus &&
    (result.exitCode === null || Number.isSafeInteger(result.exitCode)) &&
    typeof result.stdout === "string" &&
    typeof result.stderr === "string" &&
    typeof result.output === "string" &&
    typeof result.emptyOutput === "boolean" &&
    result.emptyOutput === (result.output.length === 0) &&
    typeof result.timedOut === "boolean" &&
    typeof result.cancelled === "boolean" &&
    typeof result.ambiguousSideEffects === "boolean" &&
    result.retryable === false &&
    validTimestamp(result.startedAt) &&
    validTimestamp(result.finishedAt) &&
    Date.parse(result.finishedAt) >= Date.parse(result.startedAt)
  );
}

function assertJobStatus(value: unknown, expectedJobId?: string): asserts value is JobStatus {
  const invalid = (): never => {
    throw new CueLineError(
      "JOB_STATUS_INVALID",
      `persisted job status${expectedJobId === undefined ? "" : ` for '${expectedJobId}'`} has an invalid structure`,
      expectedJobId === undefined ? undefined : { details: { jobId: expectedJobId } },
    );
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const status = value as Record<string, unknown>;
  if (
    typeof status.jobId !== "string" ||
    (expectedJobId !== undefined && status.jobId !== expectedJobId) ||
    (status.execution !== "foreground" && status.execution !== "background") ||
    typeof status.status !== "string" ||
    !JOB_STATUS_KINDS.has(status.status as JobStatusKind) ||
    !validTimestamp(status.startedAt) ||
    !optionalString(status.runId) ||
    !optionalString(status.jobKey) ||
    !optionalString(status.lane) ||
    (status.mode !== undefined && status.mode !== "advise" && status.mode !== "work") ||
    !optionalString(status.runnerId) ||
    !optionalString(status.model) ||
    !optionalString(status.provider) ||
    !optionalString(status.phase) ||
    (status.lastProgressAt !== undefined && !validTimestamp(status.lastProgressAt)) ||
    (status.pid !== undefined && (!Number.isSafeInteger(status.pid) || (status.pid as number) < 1)) ||
    (status.finishedAt !== undefined &&
      (!validTimestamp(status.finishedAt) ||
        Date.parse(status.finishedAt) < Date.parse(status.startedAt as string))) ||
    !optionalString(status.error) ||
    (status.result !== undefined &&
      !validJobResult(status.result, status.status as JobStatusKind)) ||
    ((status.status === "pending" || status.status === "running") &&
      status.result !== undefined)
  ) {
    invalid();
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(status.jobId as string)) invalid();
}

export function parseJobStatus(source: string, expectedJobId?: string): JobStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new CueLineError(
      "JOB_STATUS_INVALID",
      `persisted job status${expectedJobId === undefined ? "" : ` for '${expectedJobId}'`} is not valid JSON`,
      expectedJobId === undefined ? undefined : { details: { jobId: expectedJobId } },
    );
  }
  assertJobStatus(parsed, expectedJobId);
  return parsed;
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
    assertJobStatus(status, status.jobId);
    await mkdir(this.#directory, { recursive: true });
    const target = this.pathFor(status.jobId);
    const temporary = `${target}.${runtimePidTag()}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(status)}\n`, "utf8");
    await rename(temporary, target);
  }

  async read(jobId: string): Promise<JobStatus | undefined> {
    assertSafeJobId(jobId);
    let source: string;
    try {
      source = await readFile(this.pathFor(jobId), "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw new CueLineError("JOB_STATUS_READ_FAILED", `unable to read job status: ${jobId}`, {
        cause: error,
        details: { jobId },
      });
    }
    return parseJobStatus(source, jobId);
  }

  pathFor(jobId: string): string {
    assertSafeJobId(jobId);
    return path.join(this.#directory, `${jobId}.json`);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
