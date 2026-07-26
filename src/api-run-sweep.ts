import type { CueLineRuntimeOptions } from "./api-contracts.js";
import {
  cancelCueLineRun,
  listCueLineRuns,
  reconcileCueLineRuntime,
} from "./api-runtime-lifecycle.js";
import { classifyRunPruneRecency } from "./api-run-prune.js";
import { CueLineError } from "./core/errors.js";
import { runtimeEnvironment } from "./core/runtime.js";
import { defaultCueLineHome } from "./state/paths.js";

export type CueLineRunSweepKeptReason =
  | "unreadable"
  | "not_running"
  | "runtime_active"
  | "too_recent"
  | "unparseable_timestamp"
  | "owner_alive"
  | "workers_alive"
  | "already_terminal"
  | "sweep_failed";

export interface CueLineRunSweepDecision {
  runId: string;
  decision: "swept" | "eligible" | "kept";
  reason?: CueLineRunSweepKeptReason;
  status?: string;
  runtimeOwnership?: string;
  lastEventAt?: string;
}

export interface CueLineRunSweepError {
  runId: string;
  message: string;
}

export interface CueLineRunSweepResult {
  home: string;
  apply: boolean;
  staleMs: number;
  cutoff: string;
  decisions: CueLineRunSweepDecision[];
  sweptRuns: number;
  eligibleRuns: number;
  keptRuns: number;
  errors: CueLineRunSweepError[];
}

export interface CueLineRunSweepOptions
  extends Pick<CueLineRuntimeOptions, "home" | "environment" | "now"> {
  staleMs: number;
  apply?: boolean;
}

/**
 * Orphan sweep over persisted runs: closes `running` runs whose durable
 * evidence went silent. The sweep itself only selects candidates; every
 * closure is delegated to an existing settlement primitive that re-verifies
 * liveness before appending terminal evidence — `reconcileCueLineRuntime`
 * for process executors, `cancelCueLineRun` for caller executors — so a run
 * that is actually alive survives even when this pre-filter misjudges it.
 * Dry-run by default; run directories are never deleted (deletion stays with
 * `runs prune`).
 */
export async function sweepCueLineRuns(
  options: CueLineRunSweepOptions,
): Promise<CueLineRunSweepResult> {
  if (!Number.isFinite(options.staleMs) || options.staleMs < 0) {
    throw new CueLineError(
      "RUN_SWEEP_AGE_INVALID",
      "staleMs must be a non-negative finite number of milliseconds.",
    );
  }
  const environment = options.environment ?? runtimeEnvironment();
  const home = options.home ?? defaultCueLineHome(environment);
  const apply = options.apply === true;
  const now = options.now === undefined ? new Date() : options.now();
  const cutoffMs = now.getTime() - options.staleMs;
  const cutoff = new Date(cutoffMs).toISOString();

  const passthrough = {
    home,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  const runs = await listCueLineRuns(passthrough);
  const decisions: CueLineRunSweepDecision[] = [];
  const errors: CueLineRunSweepError[] = [];
  let sweptRuns = 0;
  let eligibleRuns = 0;
  let keptRuns = 0;

  const kept = (
    decision: Omit<CueLineRunSweepDecision, "decision">,
    reason: CueLineRunSweepKeptReason,
  ): void => {
    decisions.push({ ...decision, decision: "kept", reason });
    keptRuns += 1;
  };

  for (const run of runs) {
    if (!run.readable) {
      kept({ runId: run.runId }, "unreadable");
      continue;
    }
    const base = {
      runId: run.runId,
      status: run.status,
      runtimeOwnership: run.runtimeOwnership,
      lastEventAt: run.lastEventAt,
    };
    if (run.status !== "running") {
      kept(base, "not_running");
      continue;
    }
    if (run.runtimeOwnership === "active") {
      kept(base, "runtime_active");
      continue;
    }
    const recency = classifyRunPruneRecency(run.lastEventAt, cutoffMs);
    if (recency !== "eligible") {
      kept(base, recency);
      continue;
    }
    if (!apply) {
      decisions.push({ ...base, decision: "eligible" });
      eligibleRuns += 1;
      continue;
    }
    try {
      if (run.executor === "caller") {
        const cancelled = await cancelCueLineRun(run.runId, {
          ...passthrough,
          reason: `stale ownerless run closed by runs sweep (no durable event for ${options.staleMs}ms)`,
        });
        if (cancelled.outcome === "cancelled") {
          decisions.push({ ...base, decision: "swept" });
          sweptRuns += 1;
        } else if (cancelled.outcome === "already_terminal") {
          kept(base, "already_terminal");
        } else {
          kept(base, "owner_alive");
        }
        continue;
      }
      const reconciled = await reconcileCueLineRuntime(run.runId, passthrough);
      if (reconciled.outcome === "reconciled") {
        decisions.push({ ...base, decision: "swept" });
        sweptRuns += 1;
      } else if (reconciled.outcome === "processes_alive") {
        kept(base, "workers_alive");
      } else if (reconciled.outcome === "already_terminal") {
        kept(base, "already_terminal");
      } else {
        kept(base, "owner_alive");
      }
    } catch (error) {
      errors.push({
        runId: run.runId,
        message: error instanceof Error ? error.message : String(error),
      });
      kept(base, "sweep_failed");
    }
  }

  return {
    home,
    apply,
    staleMs: options.staleMs,
    cutoff,
    decisions,
    sweptRuns,
    eligibleRuns,
    keptRuns,
    errors,
  };
}
