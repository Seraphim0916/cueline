import { access, readdir, rm } from "node:fs/promises";
import path from "node:path";

import type { CueLineRuntimeOptions } from "./api-contracts.js";
import { listCueLineRuns } from "./api-runtime-lifecycle.js";
import { CueLineError } from "./core/errors.js";
import { runtimeEnvironment } from "./core/runtime.js";
import { JobStatusStore } from "./jobs/status.js";
import { defaultCueLineHome, runPaths } from "./state/paths.js";
import {
  readRuntimeLease,
  withRuntimeLeaseMutation,
} from "./state/runtime-lease.js";

export const PRUNABLE_RUN_STATES = ["complete", "blocked", "cancelled"] as const;

export type PrunableRunState = (typeof PRUNABLE_RUN_STATES)[number];

export type CueLineRunPruneKeptReason =
  | "unreadable"
  | "non_terminal"
  | "state_excluded"
  | "runtime_active"
  | "active_jobs"
  | "too_recent"
  | "delete_failed";

export interface CueLineRunPruneDecision {
  runId: string;
  decision: "pruned" | "eligible" | "kept";
  reason?: CueLineRunPruneKeptReason;
  status?: string;
  lastEventAt?: string;
}

export interface CueLineRunPruneError {
  runId: string;
  message: string;
}

export interface CueLineRunPruneResult {
  home: string;
  apply: boolean;
  olderThanMs: number;
  cutoff: string;
  states: PrunableRunState[];
  decisions: CueLineRunPruneDecision[];
  prunedRuns: number;
  eligibleRuns: number;
  keptRuns: number;
  removedJobRecords: number;
  errors: CueLineRunPruneError[];
}

export interface CueLineRunPruneOptions
  extends Pick<CueLineRuntimeOptions, "home" | "environment" | "now"> {
  olderThanMs: number;
  states?: readonly PrunableRunState[];
  apply?: boolean;
}

function normalizedStates(
  states: readonly PrunableRunState[] | undefined,
): PrunableRunState[] {
  const requested = states === undefined ? PRUNABLE_RUN_STATES : states;
  const unique: PrunableRunState[] = [];
  for (const state of requested) {
    if (!PRUNABLE_RUN_STATES.includes(state)) {
      throw new CueLineError(
        "RUN_PRUNE_STATE_INVALID",
        `Only terminal run states may be pruned; '${state}' is not one of: ${PRUNABLE_RUN_STATES.join(", ")}.`,
      );
    }
    if (!unique.includes(state)) unique.push(state);
  }
  if (unique.length === 0) {
    throw new CueLineError(
      "RUN_PRUNE_STATE_INVALID",
      "At least one terminal run state is required.",
    );
  }
  return unique;
}

/**
 * Only a definite ENOENT counts as "gone". Any other filesystem error
 * (EACCES, EIO, …) must propagate, otherwise the RUNTIME_MUTATION_FENCED
 * recovery path would misclassify an unverifiable directory as pruned.
 */
async function definitelyMissing(target: string): Promise<boolean> {
  try {
    await access(target);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function removeJobRecordsForRuns(
  home: string,
  runIds: ReadonlySet<string>,
  errors: CueLineRunPruneError[],
): Promise<number> {
  if (runIds.size === 0) return 0;
  const directory = path.join(home, "jobs");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  const jobIds = new Set<string>();
  for (const name of names) {
    if (name.endsWith(".json")) jobIds.add(name.slice(0, -".json".length));
    else if (name.endsWith(".terminal")) jobIds.add(name.slice(0, -".terminal".length));
  }
  const statusStore = new JobStatusStore(home);
  let removed = 0;
  for (const jobId of [...jobIds].sort()) {
    let runId: string | undefined;
    try {
      runId = (await statusStore.read(jobId))?.runId;
    } catch {
      // An unparsable job record never names a run; leave it for `jobs` to surface.
      continue;
    }
    if (runId === undefined || !runIds.has(runId)) continue;
    try {
      await rm(path.join(directory, `${jobId}.json`), { force: true });
      await rm(path.join(directory, `${jobId}.terminal`), { force: true });
      removed += 1;
    } catch (error) {
      errors.push({
        runId,
        message: `job record '${jobId}': ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return removed;
}

/**
 * Retention sweep over persisted runs. Only terminal runs (complete, blocked,
 * cancelled) whose runtime lease is not active, with zero pending or running
 * jobs, and whose last durable event is older than the cutoff are eligible.
 * Dry-run by default: nothing is deleted unless `apply` is true. Unreadable
 * runs are always kept; deciding about corrupt evidence requires a human.
 */
export async function pruneCueLineRuns(
  options: CueLineRunPruneOptions,
): Promise<CueLineRunPruneResult> {
  if (
    !Number.isFinite(options.olderThanMs) ||
    options.olderThanMs < 0
  ) {
    throw new CueLineError(
      "RUN_PRUNE_AGE_INVALID",
      "olderThanMs must be a non-negative finite number of milliseconds.",
    );
  }
  const environment = options.environment ?? runtimeEnvironment();
  const home = options.home ?? defaultCueLineHome(environment);
  const states = normalizedStates(options.states);
  const apply = options.apply === true;
  const now = options.now === undefined ? new Date() : options.now();
  const cutoffMs = now.getTime() - options.olderThanMs;
  const cutoff = new Date(cutoffMs).toISOString();

  const runs = await listCueLineRuns({
    home,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const decisions: CueLineRunPruneDecision[] = [];
  const errors: CueLineRunPruneError[] = [];
  const prunedRunIds = new Set<string>();
  let eligibleRuns = 0;
  let keptRuns = 0;

  for (const run of runs) {
    if (!run.readable) {
      decisions.push({ runId: run.runId, decision: "kept", reason: "unreadable" });
      keptRuns += 1;
      continue;
    }
    const base = {
      runId: run.runId,
      status: run.status,
      lastEventAt: run.lastEventAt,
    };
    if (!(PRUNABLE_RUN_STATES as readonly string[]).includes(run.status)) {
      decisions.push({ ...base, decision: "kept", reason: "non_terminal" });
      keptRuns += 1;
      continue;
    }
    if (!(states as readonly string[]).includes(run.status)) {
      decisions.push({ ...base, decision: "kept", reason: "state_excluded" });
      keptRuns += 1;
      continue;
    }
    if (run.runtimeOwnership === "active") {
      decisions.push({ ...base, decision: "kept", reason: "runtime_active" });
      keptRuns += 1;
      continue;
    }
    if (run.activeJobs > 0) {
      decisions.push({ ...base, decision: "kept", reason: "active_jobs" });
      keptRuns += 1;
      continue;
    }
    const lastEventMs = Date.parse(run.lastEventAt);
    if (!Number.isFinite(lastEventMs) || lastEventMs >= cutoffMs) {
      decisions.push({ ...base, decision: "kept", reason: "too_recent" });
      keptRuns += 1;
      continue;
    }
    if (!apply) {
      decisions.push({ ...base, decision: "eligible" });
      eligibleRuns += 1;
      continue;
    }
    try {
      // The inventory above is a snapshot; a runtime could claim the lease
      // between listing and deletion. Re-read and delete inside the lease
      // mutation lock so this serializes with RuntimeLease.claim — a plain
      // re-read before rm still leaves a window for a claim to land between
      // the two awaits.
      const deleted = await withRuntimeLeaseMutation(home, run.runId, async () => {
        const recheck = await readRuntimeLease(home, run.runId, {
          ...(options.now === undefined ? {} : { now: options.now }),
        });
        if (recheck.ownership === "active") return false;
        await rm(runPaths(home, run.runId).runDir, { recursive: true, force: true });
        return true;
      });
      if (!deleted) {
        decisions.push({ ...base, decision: "kept", reason: "runtime_active" });
        keptRuns += 1;
        continue;
      }
      prunedRunIds.add(run.runId);
      decisions.push({ ...base, decision: "pruned" });
    } catch (error) {
      // Deleting the run directory removes its own fence record, so the
      // lock's post-operation fence check reports RUNTIME_MUTATION_FENCED
      // for runs that ever had a runtime generation. Under the mutation lock
      // nobody else can rotate the fence, so if the directory is gone the
      // mismatch is self-inflicted and the deletion succeeded.
      if (
        error instanceof CueLineError &&
        error.code === "RUNTIME_MUTATION_FENCED" &&
        (await definitelyMissing(runPaths(home, run.runId).runDir).catch(() => false))
      ) {
        prunedRunIds.add(run.runId);
        decisions.push({ ...base, decision: "pruned" });
        continue;
      }
      errors.push({
        runId: run.runId,
        message: error instanceof Error ? error.message : String(error),
      });
      decisions.push({ ...base, decision: "kept", reason: "delete_failed" });
      keptRuns += 1;
    }
  }

  const removedJobRecords = await removeJobRecordsForRuns(home, prunedRunIds, errors);

  return {
    home,
    apply,
    olderThanMs: options.olderThanMs,
    cutoff,
    states,
    decisions,
    prunedRuns: prunedRunIds.size,
    eligibleRuns,
    keptRuns,
    removedJobRecords,
    errors,
  };
}
