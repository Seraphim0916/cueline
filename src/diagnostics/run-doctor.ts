import type { CueLineRuntimeOptions } from "../api-contracts.js";
import { loadCueLineRunStatus } from "../api-runtime-lifecycle.js";
import type {
  CueLineRunPhase,
  CueLineRunStatusSummary,
  CueLineSafeNextAction,
} from "../core/run-status.js";

export type CueLineDiagnosticSeverity = "info" | "warning" | "error";
export type CueLineRunDiagnosticOutcome = "healthy" | "action_required" | "blocked";

export interface CueLineRunDiagnosticFinding {
  code: string;
  severity: CueLineDiagnosticSeverity;
  message: string;
  action: string;
  evidence: Record<string, string | number | boolean | null>;
}

export interface CueLineRunDiagnosis {
  runId: string;
  outcome: CueLineRunDiagnosticOutcome;
  phase: CueLineRunPhase;
  summary: string;
  nextAction: CueLineSafeNextAction;
  eventSequence: number;
  findings: CueLineRunDiagnosticFinding[];
}

interface PhaseDiagnosis {
  code: string;
  severity: CueLineDiagnosticSeverity;
  summary: string;
  action: string;
}

const PHASE_DIAGNOSES: Record<CueLineRunPhase, PhaseDiagnosis> = {
  starting: {
    code: "RUN_START_READY",
    severity: "info",
    summary: "The run has not started controller work yet.",
    action: "Continue the same run once; do not create a replacement run.",
  },
  prompt_not_sent: {
    code: "PROMPT_PROVEN_NOT_SENT",
    severity: "warning",
    summary: "Durable request-correlated evidence proves the controller prompt was not sent.",
    action: "Retry the same persisted turn; do not allocate a new round.",
  },
  controller_response_pending: {
    code: "CONTROLLER_RESPONSE_PENDING",
    severity: "info",
    summary: "The controller turn was submitted and its matching response is not accepted yet.",
    action: "Observe the exact conversation and request identity; do not resend.",
  },
  jobs_running: {
    code: "PROCESS_JOBS_RUNNING",
    severity: "info",
    summary: "An explicitly authorized process executor still owns active local jobs.",
    action: "Observe job progress and the active runtime owner; do not spawn duplicates.",
  },
  controller_decision_pending: {
    code: "CONTROLLER_DECISION_READY",
    severity: "info",
    summary: "Local evidence is terminal and the controller may decide the next step.",
    action: "Continue the same run to submit the next bounded observation.",
  },
  controller_archive_pending: {
    code: "CONTROLLER_ARCHIVE_PENDING",
    severity: "warning",
    summary: "The run completed, but its opt-in controller conversation archive is unsettled.",
    action: "Continue the same run once to settle the durable archive state; never repeat a started archive click.",
  },
  caller_jobs_pending: {
    code: "CALLER_ADVICE_PENDING",
    severity: "warning",
    summary: "The controller proposed caller advice jobs that the current Codex has not completed.",
    action: "Execute each pending caller advice job once and submit terminal evidence.",
  },
  caller_work_pending: {
    code: "CALLER_WORK_NOT_STARTED",
    severity: "warning",
    summary: "The controller proposed local work, but no caller claim exists and work has not started.",
    action: "Claim the exact job before making any local mutation.",
  },
  caller_work_claimed: {
    code: "CALLER_WORK_CLAIMED_NOT_STARTED",
    severity: "warning",
    summary: "Caller work is claimed but has not been durably marked started.",
    action: "Verify the claim proof, then start that exact claim before modifying files.",
  },
  caller_work_running: {
    code: "CALLER_WORK_IN_PROGRESS",
    severity: "info",
    summary: "Caller work has a started claim and may already have local side effects.",
    action: "Continue only the exact claim; never retry the work automatically.",
  },
  runtime_active: {
    code: "RUNTIME_ACTIVE",
    severity: "info",
    summary: "A runtime owner is active even though the persisted run needs attention.",
    action: "Observe the active owner; do not take over or start a second loop.",
  },
  runtime_stale: {
    code: "RUNTIME_STALE",
    severity: "error",
    summary: "The durable runtime lease stopped heartbeating.",
    action: "Inspect matching ownership evidence, then use explicit takeover or runtime reconciliation.",
  },
  runtime_ownership_unknown: {
    code: "RUNTIME_OWNERSHIP_UNKNOWN",
    severity: "error",
    summary: "The run claims active process work without a verifiable runtime owner.",
    action: "Inspect worker liveness and reconcile runtime state before any continuation.",
  },
  cancellation_pending: {
    code: "CANCELLATION_PENDING",
    severity: "error",
    summary: "A durable cancellation request exists and normal continuation is forbidden.",
    action: "Observe cancellation settlement; inspect runtime if no owner remains.",
  },
  reconciliation_required: {
    code: "CONTROLLER_RECONCILIATION_REQUIRED",
    severity: "error",
    summary: "Controller submission or response identity remains ambiguous.",
    action: "Reconcile the exact URL, model, round, and request identity; never resend.",
  },
  job_recovery_required: {
    code: "JOB_RECOVERY_REQUIRED",
    severity: "error",
    summary: "Active-looking jobs survived a failed run without trustworthy ownership.",
    action: "Reconcile each job from process and event evidence before continuing.",
  },
  round_limit_reached: {
    code: "ROUND_LIMIT_REACHED",
    severity: "error",
    summary: "The configured controller round limit was exhausted.",
    action: "Return the recorded failure; do not silently add another round.",
  },
  resume_ready: {
    code: "RESUME_READY",
    severity: "warning",
    summary: "The failed run has no active work and may be resumed deliberately.",
    action: "Review the last failure, then continue the same run if its request is still valid.",
  },
  complete: {
    code: "RUN_COMPLETE",
    severity: "info",
    summary: "The controller accepted a complete terminal result.",
    action: "Return the persisted result; no continuation is needed.",
  },
  blocked: {
    code: "RUN_BLOCKED",
    severity: "error",
    summary: "The controller accepted a blocked terminal result.",
    action: "Return the persisted blocker; do not continue automatically.",
  },
  cancelled: {
    code: "RUN_CANCELLED",
    severity: "info",
    summary: "The run reached a cancelled terminal state.",
    action: "Return the persisted cancellation result; do not restart it implicitly.",
  },
};

function jobFinding(
  code: string,
  severity: CueLineDiagnosticSeverity,
  message: string,
  action: string,
  jobIds: readonly string[],
): CueLineRunDiagnosticFinding {
  return {
    code,
    severity,
    message,
    action,
    evidence: { count: jobIds.length, job_ids: jobIds.join(",") },
  };
}

export function diagnoseCueLineRunStatus(
  status: CueLineRunStatusSummary,
): CueLineRunDiagnosis {
  const phase = PHASE_DIAGNOSES[status.phase];
  const findings: CueLineRunDiagnosticFinding[] = [
    {
      code: phase.code,
      severity: phase.severity,
      message: phase.summary,
      action: phase.action,
      evidence: {
        phase: status.phase,
        runtime_ownership: status.runtime.ownership,
        pending_turns: status.controller.pendingTurns,
        active_jobs: status.jobs.counts.pending + status.jobs.counts.running,
      },
    },
  ];

  const ambiguous = status.jobs.items
    .filter((job) => job.status === "ambiguous")
    .map((job) => job.jobId);
  if (ambiguous.length > 0) {
    findings.push(
      jobFinding(
        "AMBIGUOUS_JOB_PRESENT",
        "error",
        "Caller work may already have side effects but lacks a trustworthy terminal result.",
        "Inspect the exact worktree and claim evidence; never retry automatically.",
        ambiguous,
      ),
    );
  }

  const orphaned = status.jobs.items
    .filter((job) => job.status === "orphaned")
    .map((job) => job.jobId);
  if (orphaned.length > 0) {
    findings.push(
      jobFinding(
        "ORPHANED_JOB_PRESENT",
        "error",
        "Persisted process jobs have no active verified owner.",
        "Reconcile process liveness and append a terminal status before continuing.",
        orphaned,
      ),
    );
  }

  const timedOut = status.jobs.items
    .filter((job) => job.status === "timed_out")
    .map((job) => job.jobId);
  if (timedOut.length > 0) {
    findings.push(
      jobFinding(
        "TIMED_OUT_JOB_EVIDENCE",
        "warning",
        "One or more jobs ended at their configured deadline.",
        "Treat timeout as evidence for the controller; do not rerun without a new command.",
        timedOut,
      ),
    );
  }

  const failed = status.jobs.items
    .filter((job) => job.status === "failed")
    .map((job) => job.jobId);
  if (failed.length > 0) {
    findings.push(
      jobFinding(
        "FAILED_JOB_EVIDENCE",
        "warning",
        "One or more jobs returned a terminal failure.",
        "Submit the bounded failure evidence to the controller; do not hide or auto-retry it.",
        failed,
      ),
    );
  }

  const outcome: CueLineRunDiagnosticOutcome = findings.some(
    (finding) => finding.severity === "error",
  )
    ? "blocked"
    : findings.some((finding) => finding.severity === "warning")
      ? "action_required"
      : "healthy";

  return {
    runId: status.runId,
    outcome,
    phase: status.phase,
    summary: phase.summary,
    nextAction: status.safeNextAction,
    eventSequence: status.lastEventSequence,
    findings,
  };
}

export async function diagnoseCueLineRun(
  runId: string,
  options: Pick<CueLineRuntimeOptions, "home" | "environment" | "now"> = {},
): Promise<CueLineRunDiagnosis> {
  return diagnoseCueLineRunStatus(await loadCueLineRunStatus(runId, options));
}
