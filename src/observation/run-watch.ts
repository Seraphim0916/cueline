import { setTimeout as delay } from "node:timers/promises";

import type { CueLineRuntimeOptions } from "../api-contracts.js";
import { loadCueLineRunStatus } from "../api-runtime-lifecycle.js";
import { CueLineError } from "../core/errors.js";
import type { CueLineRunStatusSummary } from "../core/run-status.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const MIN_POLL_INTERVAL_MS = 5;
const MAX_POLL_INTERVAL_MS = 1_000;

export interface CueLineRunWatchOptions
  extends Pick<CueLineRuntimeOptions, "home" | "environment" | "now" | "signal"> {
  afterSequence: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface CueLineRunWatchResult {
  outcome: "changed" | "terminal" | "timed_out";
  previousSequence: number;
  currentSequence: number;
  elapsedMs: number;
  status: CueLineRunStatusSummary;
}

function boundedInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CueLineError(
      "RUN_WATCH_OPTIONS_INVALID",
      `${name} must be a safe integer between ${minimum} and ${maximum}.`,
      { details: { option: name, value, minimum, maximum } },
    );
  }
  return value;
}

function terminal(status: CueLineRunStatusSummary): boolean {
  return (
    status.status === "complete" ||
    status.status === "blocked" ||
    status.status === "cancelled"
  );
}

function assertCursorNotAhead(
  runId: string,
  afterSequence: number,
  status: CueLineRunStatusSummary,
): void {
  if (afterSequence <= status.lastEventSequence) return;
  throw new CueLineError(
    "RUN_WATCH_CURSOR_AHEAD",
    `Run '${runId}' is at event ${status.lastEventSequence}, behind requested cursor ${afterSequence}.`,
    {
      details: {
        run_id: runId,
        after_sequence: afterSequence,
        current_sequence: status.lastEventSequence,
      },
    },
  );
}

function result(
  outcome: CueLineRunWatchResult["outcome"],
  afterSequence: number,
  status: CueLineRunStatusSummary,
  startedAt: number,
): CueLineRunWatchResult {
  return {
    outcome,
    previousSequence: afterSequence,
    currentSequence: status.lastEventSequence,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    status,
  };
}

async function waitInterval(milliseconds: number, signal?: AbortSignal): Promise<void> {
  try {
    await delay(milliseconds, undefined, signal === undefined ? undefined : { signal });
  } catch (error) {
    if (signal?.aborted) {
      throw new CueLineError(
        "RUN_WATCH_ABORTED",
        "Run observation was aborted without changing durable state.",
        { cause: error },
      );
    }
    throw error;
  }
}

export async function waitForCueLineRunChange(
  runId: string,
  options: CueLineRunWatchOptions,
): Promise<CueLineRunWatchResult> {
  const afterSequence = boundedInteger(
    options.afterSequence,
    "afterSequence",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const timeoutMs = boundedInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "timeoutMs",
    0,
    MAX_TIMEOUT_MS,
  );
  const pollIntervalMs = boundedInteger(
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    "pollIntervalMs",
    MIN_POLL_INTERVAL_MS,
    MAX_POLL_INTERVAL_MS,
  );
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const loadOptions = {
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };

  let status = await loadCueLineRunStatus(runId, loadOptions);
  assertCursorNotAhead(runId, afterSequence, status);
  if (terminal(status)) return result("terminal", afterSequence, status, startedAt);
  if (status.lastEventSequence > afterSequence) {
    return result("changed", afterSequence, status, startedAt);
  }

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await waitInterval(Math.min(pollIntervalMs, remaining), options.signal);
    status = await loadCueLineRunStatus(runId, loadOptions);
    assertCursorNotAhead(runId, afterSequence, status);
    if (terminal(status)) return result("terminal", afterSequence, status, startedAt);
    if (status.lastEventSequence > afterSequence) {
      return result("changed", afterSequence, status, startedAt);
    }
  }

  return result("timed_out", afterSequence, status, startedAt);
}
