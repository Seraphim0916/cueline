import type { CueLineRuntimeOptions } from "../api-contracts.js";
import { loadCueLineRunStatus } from "../api-runtime-lifecycle.js";
import type { CueLineRunStatusSummary } from "../core/run-status.js";

type DiffValue = string | number | boolean | null;

export interface CueLineRunDiffOptions
  extends Pick<CueLineRuntimeOptions, "environment" | "home" | "now"> {}

export interface CueLineRunDiffProjection {
  runId: string;
  status: string;
  executor: string;
  allowProcessExecution: boolean;
  phase: string;
  round: number;
  maxRounds: number;
  lastEventSequence: number;
  runtimeOwnership: string;
  cancellationRequested: boolean;
  pendingControllerTurns: number;
  acceptedCommands: number;
  archiveStatus: string;
  jobs: { total: number; counts: Record<string, number> };
  continueAllowed: boolean;
  safeNextAction: string;
}

export interface CueLineRunDiffChange {
  field: string;
  left: DiffValue;
  right: DiffValue;
}

export interface CueLineRunDiff {
  schema: "cueline-run-diff/0.1";
  equivalent: boolean;
  left: CueLineRunDiffProjection;
  right: CueLineRunDiffProjection;
  changes: CueLineRunDiffChange[];
}

function project(status: CueLineRunStatusSummary): CueLineRunDiffProjection {
  return {
    runId: status.runId,
    status: status.status,
    executor: status.executor,
    allowProcessExecution: status.allowProcessExecution,
    phase: status.phase,
    round: status.round,
    maxRounds: status.maxRounds,
    lastEventSequence: status.lastEventSequence,
    runtimeOwnership: status.runtime.ownership,
    cancellationRequested: status.cancellation.runRequested,
    pendingControllerTurns: status.controller.pendingTurns,
    acceptedCommands: status.controller.acceptedCommands,
    archiveStatus: status.controller.archive.status,
    jobs: { total: status.jobs.total, counts: { ...status.jobs.counts } },
    continueAllowed: status.continueAllowed,
    safeNextAction: status.safeNextAction,
  };
}

function flatten(
  value: Record<string, unknown>,
  prefix = "",
  output: Map<string, DiffValue> = new Map(),
): Map<string, DiffValue> {
  for (const key of Object.keys(value).sort()) {
    const field = prefix === "" ? key : `${prefix}.${key}`;
    const item = value[key];
    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      flatten(item as Record<string, unknown>, field, output);
    } else if (
      item === null ||
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean"
    ) {
      output.set(field, item);
    }
  }
  return output;
}

export async function compareCueLineRuns(
  leftRunId: string,
  rightRunId: string,
  options: CueLineRunDiffOptions = {},
): Promise<CueLineRunDiff> {
  const observedAt = new Date();
  const now = options.now ?? (() => observedAt);
  const [leftStatus, rightStatus] = await Promise.all([
    loadCueLineRunStatus(leftRunId, { ...options, now }),
    loadCueLineRunStatus(rightRunId, { ...options, now }),
  ]);
  const left = project(leftStatus);
  const right = project(rightStatus);
  const { runId: _leftRunId, ...leftComparable } = left;
  const { runId: _rightRunId, ...rightComparable } = right;
  const leftFields = flatten(leftComparable as Record<string, unknown>);
  const rightFields = flatten(rightComparable as Record<string, unknown>);
  const fields = [...new Set([...leftFields.keys(), ...rightFields.keys()])].sort();
  const changes = fields.flatMap((field): CueLineRunDiffChange[] => {
    const leftValue = leftFields.get(field) ?? 0;
    const rightValue = rightFields.get(field) ?? 0;
    return Object.is(leftValue, rightValue)
      ? []
      : [{ field, left: leftValue, right: rightValue }];
  });
  return {
    schema: "cueline-run-diff/0.1",
    equivalent: changes.length === 0,
    left,
    right,
    changes,
  };
}
