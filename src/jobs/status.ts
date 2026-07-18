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
    result.timedOut === (expectedStatus === "timed_out") &&
    typeof result.cancelled === "boolean" &&
    (expectedStatus === "ambiguous" ||
      result.cancelled === (expectedStatus === "cancelled")) &&
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
      (status.result !== undefined || status.finishedAt !== undefined))
  ) {
    invalid();
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(status.jobId as string)) invalid();
}

/**
 * True when a parsed job-status record carries a result object that predates
 * the `cancelled` field (evidence persisted before 0.1.7). This is the single
 * definition of "legacy job evidence": readers backfill it, and upgrade
 * preflight warns on it so an operator knows compat-shimmed evidence exists.
 */
export function jobStatusRecordIsLegacy(parsed: unknown): boolean {
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    typeof (parsed as { result?: unknown }).result === "object" &&
    (parsed as { result?: unknown }).result !== null &&
    (parsed as { result: Record<string, unknown> }).result.cancelled === undefined
  );
}

/** True when raw persisted JSON is pre-0.1.7 legacy job evidence. */
export function isLegacyJobStatusSource(source: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return false;
  }
  return jobStatusRecordIsLegacy(parsed);
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
  // Evidence persisted before 0.1.7 predates the `cancelled` field. Reads
  // backfill the only value those writers could have meant; writes stay strict.
  if (jobStatusRecordIsLegacy(parsed)) {
    (parsed as { result: Record<string, unknown> }).result.cancelled = false;
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
    assertJobStatus(status, status.jobId);
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
    let source: string;
    try {
      source = await readFile(target, "utf8");
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
    return parseJobStatus(source, jobId);
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
