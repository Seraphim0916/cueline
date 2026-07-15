import type { CueLineRunStatusSummary } from "../core/run-status.js";

function present<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/**
 * Build the metadata-only CLI view explicitly instead of deleting known
 * sensitive fields. New fields added to the internal status summary therefore
 * remain private until they are deliberately reviewed for CLI exposure.
 */
export function safeCueLineRunStatus(status: CueLineRunStatusSummary) {
  return {
    runId: status.runId,
    status: status.status,
    executor: status.executor,
    allowProcessExecution: status.allowProcessExecution,
    phase: status.phase,
    round: status.round,
    maxRounds: status.maxRounds,
    lastEventSequence: status.lastEventSequence,
    runtime: {
      ownership: status.runtime.ownership,
      ...(present(status.runtime.heartbeatAt)
        ? { heartbeatAt: status.runtime.heartbeatAt }
        : {}),
      ...(present(status.runtime.ageMs) ? { ageMs: status.runtime.ageMs } : {}),
      ...(present(status.runtime.pid) ? { pid: status.runtime.pid } : {}),
    },
    cancellation: {
      runRequested: status.cancellation.runRequested,
      jobRequests: [...status.cancellation.jobRequests],
    },
    controller: {
      pendingTurns: status.controller.pendingTurns,
      acceptedCommands: status.controller.acceptedCommands,
      responseAccepted: status.controller.responseAccepted,
      lastAcceptedAction: status.controller.lastAcceptedAction,
      lastAcceptedRequestId: status.controller.lastAcceptedRequestId,
      lastAcceptedJobKeys: [...status.controller.lastAcceptedJobKeys],
    },
    jobs: {
      total: status.jobs.total,
      counts: {
        pending: status.jobs.counts.pending,
        running: status.jobs.counts.running,
        succeeded: status.jobs.counts.succeeded,
        failed: status.jobs.counts.failed,
        timed_out: status.jobs.counts.timed_out,
        cancelled: status.jobs.counts.cancelled,
        ambiguous: status.jobs.counts.ambiguous,
        orphaned: status.jobs.counts.orphaned,
      },
      items: status.jobs.items.map((job) => ({
        jobId: job.jobId,
        jobKey: job.jobKey,
        required: job.required,
        lane: job.lane,
        mode: job.mode,
        status: job.status,
        persistedStatus: job.persistedStatus,
        ...(job.workClaim === undefined
          ? {}
          : {
              workClaim: {
                claimed: job.workClaim.claimed,
                ...(present(job.workClaim.claimedAt)
                  ? { claimedAt: job.workClaim.claimedAt }
                  : {}),
                ...(present(job.workClaim.heartbeatAt)
                  ? { heartbeatAt: job.workClaim.heartbeatAt }
                  : {}),
                ...(present(job.workClaim.expiresAt)
                  ? { expiresAt: job.workClaim.expiresAt }
                  : {}),
                ...(present(job.workClaim.startedAt)
                  ? { startedAt: job.workClaim.startedAt }
                  : {}),
              },
            }),
        ...(job.execution === undefined
          ? {}
          : {
              execution: {
                ...(present(job.execution.runnerId)
                  ? { runnerId: job.execution.runnerId }
                  : {}),
                ...(present(job.execution.pid) ? { pid: job.execution.pid } : {}),
                ...(present(job.execution.model) ? { model: job.execution.model } : {}),
                ...(present(job.execution.provider)
                  ? { provider: job.execution.provider }
                  : {}),
                ...(present(job.execution.phase) ? { phase: job.execution.phase } : {}),
                ...(present(job.execution.lastProgressAt)
                  ? { lastProgressAt: job.execution.lastProgressAt }
                  : {}),
              },
            }),
      })),
    },
    continueAllowed: status.continueAllowed,
    safeNextAction: status.safeNextAction,
  };
}
