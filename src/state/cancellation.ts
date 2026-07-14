import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { CueLineError } from "../core/errors.js";
import { atomicWriteJson } from "./atomic-write.js";
import { runPaths } from "./paths.js";

const CANCELLATION_PROTOCOL = "cueline/cancellation/0.1";
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface RunCancellationRequest {
  protocol: typeof CANCELLATION_PROTOCOL;
  run_id: string;
  target: "run";
  reason: string;
  requested_at: string;
}

export interface JobCancellationRequest {
  protocol: typeof CANCELLATION_PROTOCOL;
  run_id: string;
  target: "job";
  job_id: string;
  reason: string;
  requested_at: string;
}

export interface CancellationObservation {
  runRequested: boolean;
  jobRequests: string[];
}

export interface CancellationWatcherOptions {
  home: string;
  runId: string;
  intervalMs?: number;
  onRun(request: RunCancellationRequest): void | Promise<void>;
  onJob(request: JobCancellationRequest): void | Promise<void>;
  onError(error: unknown): void;
}

function assertJobId(jobId: string): void {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new CueLineError("JOB_ID_INVALID", "job id contains unsupported path characters", {
      details: { jobId },
    });
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function parseRequest(
  source: string,
  runId: string,
): RunCancellationRequest | JobCancellationRequest {
  const value = JSON.parse(source) as Record<string, unknown>;
  if (
    value.protocol !== CANCELLATION_PROTOCOL ||
    value.run_id !== runId ||
    (value.target !== "run" && value.target !== "job") ||
    typeof value.reason !== "string" ||
    value.reason.trim() === "" ||
    typeof value.requested_at !== "string" ||
    (value.target === "job" &&
      (typeof value.job_id !== "string" || !JOB_ID_PATTERN.test(value.job_id)))
  ) {
    throw new CueLineError(
      "CANCELLATION_REQUEST_INVALID",
      `CueLine run '${runId}' has an invalid cancellation request.`,
    );
  }
  if (value.target === "run") {
    return {
      protocol: CANCELLATION_PROTOCOL,
      run_id: runId,
      target: "run",
      reason: value.reason as string,
      requested_at: value.requested_at as string,
    };
  }
  return {
    protocol: CANCELLATION_PROTOCOL,
    run_id: runId,
    target: "job",
    job_id: value.job_id as string,
    reason: value.reason as string,
    requested_at: value.requested_at as string,
  };
}

export async function requestRunCancellation(
  home: string,
  runId: string,
  reason: string,
  now: () => Date = () => new Date(),
): Promise<RunCancellationRequest> {
  const request: RunCancellationRequest = {
    protocol: CANCELLATION_PROTOCOL,
    run_id: runId,
    target: "run",
    reason,
    requested_at: now().toISOString(),
  };
  await atomicWriteJson(runPaths(home, runId).runCancellation, request);
  return request;
}

export async function requestJobCancellation(
  home: string,
  runId: string,
  jobId: string,
  reason: string,
  now: () => Date = () => new Date(),
): Promise<JobCancellationRequest> {
  assertJobId(jobId);
  const request: JobCancellationRequest = {
    protocol: CANCELLATION_PROTOCOL,
    run_id: runId,
    target: "job",
    job_id: jobId,
    reason,
    requested_at: now().toISOString(),
  };
  await atomicWriteJson(
    path.join(runPaths(home, runId).jobCancellationsDir, `${jobId}.json`),
    request,
  );
  return request;
}

export async function readRunCancellation(
  home: string,
  runId: string,
): Promise<RunCancellationRequest | undefined> {
  try {
    const request = parseRequest(
      await readFile(runPaths(home, runId).runCancellation, "utf8"),
      runId,
    );
    if (request.target !== "run") {
      throw new CueLineError(
        "CANCELLATION_REQUEST_INVALID",
        `CueLine run '${runId}' has a job request in its run cancellation path.`,
      );
    }
    return request;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

export async function readJobCancellations(
  home: string,
  runId: string,
): Promise<JobCancellationRequest[]> {
  const directory = runPaths(home, runId).jobCancellationsDir;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const requests: JobCancellationRequest[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith(".json")).sort()) {
    const request = parseRequest(await readFile(path.join(directory, name), "utf8"), runId);
    if (request.target !== "job") {
      throw new CueLineError(
        "CANCELLATION_REQUEST_INVALID",
        `CueLine run '${runId}' has a run request in its job cancellation directory.`,
      );
    }
    requests.push(request);
  }
  return requests;
}

export async function readCancellationObservation(
  home: string,
  runId: string,
): Promise<CancellationObservation> {
  const [runRequest, jobRequests] = await Promise.all([
    readRunCancellation(home, runId),
    readJobCancellations(home, runId),
  ]);
  return {
    runRequested: runRequest !== undefined,
    jobRequests: jobRequests.map((request) => request.job_id),
  };
}

export class CancellationWatcher {
  readonly #seenJobs = new Set<string>();
  #sawRun = false;
  #timer: NodeJS.Timeout | undefined;
  #pollChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: CancellationWatcherOptions) {}

  start(): void {
    if (this.#timer !== undefined) return;
    const schedule = (): void => {
      this.#pollChain = this.#pollChain.then(() => this.poll()).catch((error) => {
        this.options.onError(error);
      });
    };
    schedule();
    this.#timer = setInterval(schedule, this.options.intervalMs ?? 250);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#pollChain;
  }

  private async poll(): Promise<void> {
    if (!this.#sawRun) {
      const request = await readRunCancellation(this.options.home, this.options.runId);
      if (request !== undefined) {
        this.#sawRun = true;
        await this.options.onRun(request);
      }
    }
    for (const request of await readJobCancellations(this.options.home, this.options.runId)) {
      if (this.#seenJobs.has(request.job_id)) continue;
      this.#seenJobs.add(request.job_id);
      await this.options.onJob(request);
    }
  }
}
