import { CueLineError } from "./errors.js";
import {
  isControllerTurnProvenUnsent,
  type CueLineRunState,
  type StoredJobStatus,
} from "./state-machine.js";
import type { RuntimeLeaseObservation } from "../state/runtime-lease.js";
import type { CancellationObservation } from "../state/cancellation.js";
import type { RunEvent } from "../state/event-log.js";

const JOB_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "ambiguous",
] as const satisfies readonly StoredJobStatus[];
const OBSERVED_JOB_STATUSES = [...JOB_STATUSES, "orphaned"] as const;
export type CueLineObservedJobStatus = (typeof OBSERVED_JOB_STATUSES)[number];

export type CueLineRunPhase =
  | "starting"
  | "prompt_not_sent"
  | "controller_response_pending"
  | "jobs_running"
  | "controller_decision_pending"
  | "caller_jobs_pending"
  | "runtime_active"
  | "runtime_stale"
  | "runtime_ownership_unknown"
  | "cancellation_pending"
  | "reconciliation_required"
  | "job_recovery_required"
  | "round_limit_reached"
  | "resume_ready"
  | "complete"
  | "blocked"
  | "cancelled";

export type CueLineSafeNextAction =
  | "observe"
  | "retry"
  | "reconcile"
  | "inspect_jobs_then_continue"
  | "inspect_runtime"
  | "continue"
  | "execute_caller_jobs"
  | "return_result";

export interface CueLineRunStatusSummary {
  runId: string;
  status: CueLineRunState["status"];
  executor: CueLineRunState["executor"];
  phase: CueLineRunPhase;
  round: number;
  maxRounds: number;
  lastEventSequence: number;
  runtime: RuntimeLeaseObservation;
  cancellation: CancellationObservation;
  controller: {
    pendingTurns: number;
    acceptedCommands: number;
    responseAccepted: boolean;
    lastAcceptedAction: "dispatch" | "wait" | "inspect" | "complete" | "blocked" | null;
    lastAcceptedRequestId: string | null;
    lastAcceptedJobKeys: string[];
  };
  jobs: {
    total: number;
    counts: Record<CueLineObservedJobStatus, number>;
    items: Array<{
      jobId: string;
      jobKey: string;
      required: boolean;
      lane: string;
      mode: string;
      task: string;
      status: CueLineObservedJobStatus;
      persistedStatus: StoredJobStatus;
    }>;
  };
  continueAllowed: boolean;
  safeNextAction: CueLineSafeNextAction;
}

export interface AcceptedControllerCommandEvidence {
  action: CueLineRunStatusSummary["controller"]["lastAcceptedAction"];
  requestId: string | null;
  jobKeys: string[];
}

export function acceptedControllerCommandEvidence(
  events: readonly RunEvent[],
): AcceptedControllerCommandEvidence {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "controller_command_accepted") continue;
    const payload = event.payload as Record<string, unknown>;
    const command = payload.command;
    if (typeof command !== "object" || command === null || Array.isArray(command)) continue;
    const record = command as Record<string, unknown>;
    const action =
      record.action === "dispatch" ||
      record.action === "wait" ||
      record.action === "inspect" ||
      record.action === "complete" ||
      record.action === "blocked"
        ? record.action
        : null;
    if (action === null) continue;
    const jobs = Array.isArray(record.jobs) ? record.jobs : [];
    return {
      action,
      requestId: typeof record.request_id === "string" ? record.request_id : null,
      jobKeys: jobs.flatMap((job) => {
        if (typeof job !== "object" || job === null || Array.isArray(job)) return [];
        const jobKey = (job as Record<string, unknown>).job_key;
        return typeof jobKey === "string" ? [jobKey] : [];
      }),
    };
  }
  return { action: null, requestId: null, jobKeys: [] };
}

function activeJobCount(state: CueLineRunState): number {
  return Object.values(state.jobs).filter(
    (job) => job.status === "pending" || job.status === "running",
  ).length;
}

function isPristineRun(state: CueLineRunState): boolean {
  return (
    state.round === 0 &&
    state.pendingControllerTurns.length === 0 &&
    state.commandHashes.length === 0 &&
    Object.keys(state.jobs).length === 0
  );
}

function roundLimitReached(state: CueLineRunState): boolean {
  return (
    state.status === "failed" &&
    state.lastFailure?.code === "MAX_ROUNDS_EXCEEDED" &&
    state.pendingControllerTurns.length === 0 &&
    activeJobCount(state) === 0 &&
    state.round >= state.maxRounds
  );
}

function hasRetryableUnsentTurn(state: CueLineRunState): boolean {
  return (
    state.pendingControllerTurns.length === 1 &&
    isControllerTurnProvenUnsent(state, state.pendingControllerTurns[0])
  );
}

function safeNextActionFor(
  state: CueLineRunState,
  runtime: RuntimeLeaseObservation,
  cancellation: CancellationObservation,
): CueLineSafeNextAction {
  if (state.status === "complete" || state.status === "blocked" || state.status === "cancelled") {
    return "return_result";
  }
  if (cancellation.runRequested) {
    return runtime.ownership === "active" ? "observe" : "inspect_runtime";
  }
  if (runtime.ownership === "active") return "observe";
  if (state.executor === "caller" && activeJobCount(state) > 0) {
    return "execute_caller_jobs";
  }
  if (runtime.ownership === "stale" || runtime.ownership === "invalid") {
    return "inspect_runtime";
  }
  if (hasRetryableUnsentTurn(state)) return "retry";
  if (state.pendingControllerTurns.length > 0) {
    const turn = state.pendingControllerTurns[0];
    const normallySubmitted =
      state.pendingControllerTurns.length === 1 &&
      turn?.submissionState === "submitted" &&
      !turn.manualSendConfirmed;
    return normallySubmitted ? "observe" : "reconcile";
  }
  if (roundLimitReached(state)) return "return_result";
  if (isPristineRun(state) && state.status === "running") return "continue";
  if (state.executor === "caller" && state.status === "running") return "continue";
  if (state.status === "running") return "inspect_runtime";
  if (activeJobCount(state) > 0) return "inspect_jobs_then_continue";
  return "continue";
}

export function cueLineRunPhase(
  state: CueLineRunState,
  runtime: RuntimeLeaseObservation,
  cancellation: CancellationObservation = { runRequested: false, jobRequests: [] },
): CueLineRunPhase {
  if (state.status === "complete") return "complete";
  if (state.status === "blocked") return "blocked";
  if (state.status === "cancelled") return "cancelled";
  if (cancellation.runRequested) return "cancellation_pending";
  if (state.status === "failed" && runtime.ownership === "active") return "runtime_active";
  if (runtime.ownership === "stale") return "runtime_stale";
  if (isPristineRun(state) && runtime.ownership !== "active") return "starting";
  if (runtime.ownership !== "active" && hasRetryableUnsentTurn(state)) {
    return "prompt_not_sent";
  }
  if (state.status === "running" && state.pendingControllerTurns.length > 0) {
    return "controller_response_pending";
  }
  if (
    state.executor === "caller" &&
    runtime.ownership !== "active" &&
    activeJobCount(state) > 0
  ) {
    return "caller_jobs_pending";
  }
  if (state.status === "failed") {
    if (state.pendingControllerTurns.length > 0) return "reconciliation_required";
    if (activeJobCount(state) > 0) return "job_recovery_required";
    if (roundLimitReached(state)) return "round_limit_reached";
    return "resume_ready";
  }
  if (runtime.ownership !== "active") {
    if (state.executor === "caller") {
      return state.commandHashes.length > 0 ? "controller_decision_pending" : "starting";
    }
    return "runtime_ownership_unknown";
  }
  if (activeJobCount(state) > 0) return "jobs_running";
  if (state.commandHashes.length > 0) return "controller_decision_pending";
  return "starting";
}

export function assertRunCanContinue(
  state: CueLineRunState,
  runtime: RuntimeLeaseObservation,
  cancellation: CancellationObservation = { runRequested: false, jobRequests: [] },
): void {
  if (cancellation.runRequested) {
    throw new CueLineError(
      "RUN_CANCELLATION_PENDING",
      `CueLine run '${state.runId}' has a durable cancellation request; continuation is forbidden.`,
      { details: { run_id: state.runId, phase: "cancellation_pending" } },
    );
  }
  const inspect = `Inspect it with 'cueline run status ${state.runId} --json'; do not resend it.`;
  if (runtime.ownership === "active") {
    throw new CueLineError(
      "RUN_ALREADY_ACTIVE",
      `CueLine run '${state.runId}' still has an active controller loop. ${inspect}`,
      { details: { run_id: state.runId, phase: cueLineRunPhase(state, runtime) } },
    );
  }
  if (runtime.ownership === "stale") {
    throw new CueLineError(
      "RUN_STALE_REQUIRES_TAKEOVER",
      `CueLine run '${state.runId}' stopped heartbeating; explicit recovery is required. ${inspect}`,
      { details: { run_id: state.runId, phase: cueLineRunPhase(state, runtime) } },
    );
  }
  if (runtime.ownership === "invalid") {
    throw new CueLineError(
      "RUNTIME_LEASE_INVALID",
      `CueLine run '${state.runId}' has unreadable runtime ownership evidence. ${inspect}`,
      { details: { run_id: state.runId, phase: cueLineRunPhase(state, runtime) } },
    );
  }
  if (state.status !== "running") return;
  if (
    isPristineRun(state) &&
    (runtime.ownership === "missing" || runtime.ownership === "released")
  ) {
    return;
  }
  if (
    state.executor === "caller" &&
    (runtime.ownership === "missing" || runtime.ownership === "released")
  ) {
    return;
  }
  throw new CueLineError(
    "RUN_OWNERSHIP_UNVERIFIED",
    `CueLine run '${state.runId}' is marked running but has no verifiable active owner. ${inspect}`,
    { details: { run_id: state.runId, phase: cueLineRunPhase(state, runtime) } },
  );
}

export function summarizeCueLineRunState(
  state: CueLineRunState,
  lastEventSequence: number,
  runtime: RuntimeLeaseObservation,
  cancellation: CancellationObservation = { runRequested: false, jobRequests: [] },
  acceptedCommand: AcceptedControllerCommandEvidence = {
    action: null,
    requestId: null,
    jobKeys: [],
  },
): CueLineRunStatusSummary {
  const counts = Object.fromEntries(
    OBSERVED_JOB_STATUSES.map((status) => [status, 0]),
  ) as Record<CueLineObservedJobStatus, number>;
  const items = Object.values(state.jobs).map((job) => {
    const status: CueLineObservedJobStatus =
      (job.status === "pending" || job.status === "running") &&
      state.executor !== "caller" &&
      runtime.ownership !== "active"
        ? "orphaned"
        : job.status;
    counts[status] += 1;
    return {
      jobId: job.jobId,
      jobKey: job.jobKey,
      required: job.required,
      lane: job.spec.lane,
      mode: job.spec.mode,
      task: job.spec.task,
      status,
      persistedStatus: job.status,
    };
  });
  const phase = cueLineRunPhase(state, runtime, cancellation);
  const continueAllowed =
    !cancellation.runRequested &&
    !roundLimitReached(state) &&
    (runtime.ownership === "missing" || runtime.ownership === "released") &&
    ((state.status === "failed") ||
      (state.executor === "caller" && activeJobCount(state) === 0));
  const safeNextAction = safeNextActionFor(state, runtime, cancellation);
  return {
    runId: state.runId,
    status: state.status,
    executor: state.executor,
    phase,
    round: state.round,
    maxRounds: state.maxRounds,
    lastEventSequence,
    runtime,
    cancellation,
    controller: {
      pendingTurns: state.pendingControllerTurns.length,
      acceptedCommands: state.commandHashes.length,
      responseAccepted:
        state.pendingControllerTurns.length === 0 &&
        (acceptedCommand.action !== null || state.commandHashes.length > 0),
      lastAcceptedAction: acceptedCommand.action,
      lastAcceptedRequestId: acceptedCommand.requestId,
      lastAcceptedJobKeys: acceptedCommand.jobKeys,
    },
    jobs: {
      total: items.length,
      counts,
      items,
    },
    continueAllowed,
    safeNextAction,
  };
}
