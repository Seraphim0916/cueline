import { randomUUID } from "node:crypto";

import type { BrowserSubmittedTurnEvidence } from "../browser/browser-adapter.js";
import { JobStatusStore } from "../jobs/status.js";
import {
  CancellationWatcher,
  readCancellationObservation,
} from "../state/cancellation.js";
import { defaultCueLineHome } from "../state/paths.js";
import { readRuntimeLease, RuntimeLease } from "../state/runtime-lease.js";
import { RunStore } from "../state/store.js";
import { throwIfCancelled } from "./controller-abort.js";
import {
  controllerConversationArchiveNeedsRecovery,
  settleControllerConversationArchive,
} from "./controller-conversation-archive.js";
import {
  executeAcceptedCommand,
  statusPayload,
  validateCommandBeforeAcceptance,
  type CommandExecutionOutcome,
} from "./controller-command-execution.js";
import {
  capControllerEvidence,
  capReplayedControllerEvidence,
  DEFAULT_MAX_JOB_EVIDENCE_CHARS,
} from "./controller-evidence.js";
import {
  assertConversationUrlCompatible,
  controllerResultOutput,
  observationFor,
  requestControllerCommand,
  truncate,
} from "./controller-turn.js";
import type {
  ContinueControllerLoopOptions,
  ControllerLoopOptions,
  ControllerRuntimeOptions,
  CreateControllerRunOptions,
  CueLineResult,
  JobSupervisorLike,
} from "./controller-types.js";
import { asCueLineError, CueLineError } from "./errors.js";
import { commandHash, messageId, runId as createRunId } from "./ids.js";
import { validatedTimerDelay } from "./timing.js";
import {
  assertRunCanContinue,
  isSafeStaleCallerObservationRecovery,
} from "./run-status.js";
import {
  DEFAULT_MAX_REPAIR_ATTEMPTS,
  DEFAULT_MAX_ROUNDS,
  initialRunState,
  isControllerTurnProvenUnsent,
  jobObservations,
  reduceRunState,
  type CueLineRunState,
} from "./state-machine.js";
import {
  isDefinitelyNotSentObservation,
  isSubmittedTurnRecoveryCandidate,
} from "./submitted-turn-recovery.js";

export type {
  ContinueControllerLoopOptions,
  ControllerLoopOptions,
  ControllerRuntimeOptions,
  CreateControllerRunOptions,
  CueLineResult,
  JobSupervisorLike,
} from "./controller-types.js";

function resultFromState(state: CueLineRunState): CueLineResult {
  if (
    state.status !== "complete" &&
    state.status !== "blocked" &&
    state.status !== "cancelled"
  ) {
    throw new CueLineError("RUN_NOT_TERMINAL", "CueLine result requested before a terminal state.");
  }
  return {
    runId: state.runId,
    status: state.status,
    ...(state.finalDeliveryText === null ? {} : { finalDeliveryText: state.finalDeliveryText }),
    ...(state.conversationUrl === null ? {} : { conversationUrl: state.conversationUrl }),
    ...(state.cancelledReason === null ? {} : { cancelledReason: state.cancelledReason }),
    state,
  };
}

function awaitingCallerResult(state: CueLineRunState): CueLineResult {
  const pendingJobs = Object.values(state.jobs)
    .filter((job) => job.status === "pending" || job.status === "running");
  const hasWork = pendingJobs.some((job) => job.spec.mode === "work");
  return {
    runId: state.runId,
    status: hasWork ? "awaiting_caller_work" : "awaiting_caller",
    ...(state.conversationUrl === null ? {} : { conversationUrl: state.conversationUrl }),
    state,
    pendingJobs,
  };
}

function awaitingControllerResult(state: CueLineRunState): CueLineResult {
  return {
    runId: state.runId,
    status: "awaiting_controller",
    ...(state.conversationUrl === null ? {} : { conversationUrl: state.conversationUrl }),
    state,
  };
}

function readyResult(state: CueLineRunState): CueLineResult {
  return {
    runId: state.runId,
    status: "ready",
    state,
  };
}

function isRunCancellation(error: unknown): error is CueLineError {
  return error instanceof CueLineError && error.code === "RUN_CANCELLED";
}

function postCreateFailure(error: unknown, runId: string): CueLineError {
  const normalized = asCueLineError(error);
  const details =
    typeof normalized.details === "object" &&
    normalized.details !== null &&
    !Array.isArray(normalized.details)
      ? (normalized.details as Record<string, unknown>)
      : {};
  const originalCode =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : normalized.code;
  return new CueLineError(originalCode, normalized.message, {
    cause: error,
    details: { ...details, run_id: runId },
  });
}

function failurePayload(
  error: unknown,
  state: CueLineRunState,
): Record<string, unknown> {
  const normalized = asCueLineError(error);
  const details =
    typeof normalized.details === "object" &&
    normalized.details !== null &&
    !Array.isArray(normalized.details)
      ? (normalized.details as Record<string, unknown>)
      : {};
  const requestId = typeof details.request_id === "string" ? details.request_id : undefined;
  const pendingTurns = state.pendingControllerTurns ?? [];
  const pending =
    requestId === undefined
      ? pendingTurns.length === 1
        ? pendingTurns[0]
        : undefined
      : pendingTurns.find((turn) => turn.requestId === requestId);
  const stage =
    typeof details.stage === "string"
      ? details.stage
      : pending
        ? "controller_turn"
        : "controller_loop";
  const submissionState =
    typeof details.submission_state === "string"
      ? details.submission_state
      : pending?.submissionState;
  const conversationUrl = pending?.conversationUrl ?? state.conversationUrl;
  const failureRequestId = requestId ?? pending?.requestId;
  return {
    code: normalized.code,
    message: truncate(normalized.message, 2_000),
    stage,
    ...(failureRequestId === undefined ? {} : { request_id: failureRequestId }),
    ...(submissionState === undefined ? {} : { submission_state: submissionState }),
    ...(conversationUrl === null ? {} : { conversation_url: conversationUrl }),
  };
}

async function recordRunFailure(
  store: RunStore<CueLineRunState>,
  error: unknown,
): Promise<void> {
  if (store.state.status !== "running") return;
  await store.append("run_failed", failurePayload(error, store.state));
  await store.snapshot();
}

async function settleCancelledJobs(
  store: RunStore<CueLineRunState>,
  supervisor: JobSupervisorLike,
): Promise<void> {
  const active = Object.values(store.state.jobs).filter(
    (job) => job.status === "pending" || job.status === "running",
  );
  for (const job of active) {
    try {
      const status = await supervisor.waitForCompletion(job.jobId);
      await store.append(
        "job_status",
        status.status === "running"
          ? {
              job_id: job.jobId,
              status: "ambiguous",
              error: "Cancellation was requested, but the supervisor could not confirm termination.",
            }
          : statusPayload(status, store.state.maxJobEvidenceChars),
      );
    } catch (error) {
      const failure = asCueLineError(error, "JOB_CANCELLATION_UNVERIFIED");
      await store.append("job_status", {
        job_id: job.jobId,
        status: "ambiguous",
        error: truncate(failure.message),
      });
    }
  }
}

async function handleControllerFailure(
  store: RunStore<CueLineRunState>,
  supervisor: JobSupervisorLike,
  error: unknown,
): Promise<CueLineResult> {
  if (isRunCancellation(error)) {
    supervisor.cancelAll?.();
    await settleCancelledJobs(store, supervisor);
    if (store.state.status !== "cancelled") {
      await store.append("run_cancelled", { reason: error.message });
      await store.snapshot();
    }
    return resultFromState(store.state);
  }
  const hasActiveOwnedProcessJobs =
    store.state.executor === "process" &&
    Object.values(store.state.jobs).some(
      (job) => job.status === "pending" || job.status === "running",
    );
  if (hasActiveOwnedProcessJobs) {
    supervisor.cancelAll?.();
    await settleCancelledJobs(store, supervisor);
  }
  await recordRunFailure(store, error);
  throw postCreateFailure(error, store.runId);
}

interface OwnedCancellation {
  options: ControllerRuntimeOptions & { signal: AbortSignal };
  stop(): Promise<void>;
}

function watchOwnedCancellation(
  home: string,
  runId: string,
  options: ControllerRuntimeOptions,
): OwnedCancellation {
  const requested = new AbortController();
  const signal =
    options.signal === undefined
      ? requested.signal
      : AbortSignal.any([options.signal, requested.signal]);
  const cancelAll = (): void => {
    options.jobSupervisor.cancelAll?.();
  };
  signal.addEventListener("abort", cancelAll, { once: true });
  const timeoutTimer =
    options.runTimeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          requested.abort(
            new CueLineError(
              "RUN_TIMEOUT",
              `CueLine run '${runId}' exceeded its ${options.runTimeoutMs} ms run timeout.`,
              { details: { run_id: runId, timeout_ms: options.runTimeoutMs } },
            ),
          );
        }, options.runTimeoutMs);
  const watcher = new CancellationWatcher({
    home,
    runId,
    ...(options.cancellationPollIntervalMs === undefined
      ? {}
      : { intervalMs: options.cancellationPollIntervalMs }),
    onRun(request) {
      requested.abort(
        new CueLineError("RUN_CANCELLED", request.reason, {
          details: { run_id: runId, requested_at: request.requested_at },
        }),
      );
    },
    async onJob(request) {
      if (options.jobSupervisor.cancel?.(request.job_id) === true) return true;
      try {
        const status = await options.jobSupervisor.inspect(request.job_id);
        return status.status !== "running";
      } catch {
        return false;
      }
    },
    onError(error) {
      requested.abort(
        new CueLineError(
          "CANCELLATION_WATCH_FAILED",
          `CueLine run '${runId}' could not read cancellation requests.`,
          { cause: error },
        ),
      );
    },
  });
  watcher.start();
  return {
    options: { ...options, signal },
    async stop() {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      signal.removeEventListener("abort", cancelAll);
      await watcher.stop();
    },
  };
}

type ControllerRuntimeLimitOptions = Pick<
  ControllerRuntimeOptions,
  | "maxRounds"
  | "maxJobEvidenceChars"
  | "maxRepairAttempts"
  | "runTimeoutMs"
  | "cancellationPollIntervalMs"
  | "runtimeHeartbeatIntervalMs"
  | "maxConcurrency"
  | "laneConcurrency"
  | "archiveControllerConversationOnComplete"
>;

export function validateControllerRuntimeOptions(options: ControllerRuntimeLimitOptions): {
  maxRounds: number;
  maxJobEvidenceChars: number;
  maxRepairAttempts: number;
  laneConcurrency: Readonly<Record<string, number>> | undefined;
} {
  validatedArchivePolicy(options.archiveControllerConversationOnComplete);
  const maxRounds = validatedMaxRounds(options.maxRounds);
  const maxJobEvidenceChars = validatedMaxJobEvidenceChars(options.maxJobEvidenceChars);
  const maxRepairAttempts = validatedMaxRepairAttempts(options.maxRepairAttempts);
  if (options.runTimeoutMs !== undefined) {
    validatedTimerDelay(options.runTimeoutMs, {
      code: "RUN_TIMEOUT_INVALID",
      name: "runTimeoutMs",
    });
  }
  if (options.cancellationPollIntervalMs !== undefined) {
    validatedTimerDelay(options.cancellationPollIntervalMs, {
      code: "CANCELLATION_POLL_INTERVAL_INVALID",
      name: "cancellationPollIntervalMs",
    });
  }
  if (options.runtimeHeartbeatIntervalMs !== undefined) {
    validatedTimerDelay(options.runtimeHeartbeatIntervalMs, {
      code: "RUNTIME_HEARTBEAT_INTERVAL_INVALID",
      name: "runtimeHeartbeatIntervalMs",
    });
  }
  const maxConcurrency = options.maxConcurrency ?? 2;
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new CueLineError(
      "MAX_CONCURRENCY_INVALID",
      "maxConcurrency must be a positive integer.",
    );
  }
  const laneConcurrency: unknown = options.laneConcurrency;
  let normalizedLaneConcurrency: Readonly<Record<string, number>> | undefined;
  if (laneConcurrency !== undefined) {
    if (
      laneConcurrency === null ||
      typeof laneConcurrency !== "object" ||
      Array.isArray(laneConcurrency)
    ) {
      throw new CueLineError(
        "LANE_CONCURRENCY_INVALID",
        "laneConcurrency must be a record of positive integer limits.",
      );
    }
    const ownLimits: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const [lane, limit] of Object.entries(laneConcurrency)) {
      if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1) {
        throw new CueLineError(
          "LANE_CONCURRENCY_INVALID",
          `laneConcurrency['${lane}'] must be a positive integer.`,
        );
      }
      ownLimits[lane] = limit;
    }
    normalizedLaneConcurrency = Object.freeze(ownLimits);
  }
  return {
    maxRounds,
    maxJobEvidenceChars,
    maxRepairAttempts,
    laneConcurrency: normalizedLaneConcurrency,
  };
}

function validatedRuntimeOptions<Options extends ControllerRuntimeOptions>(
  options: Options,
): Options {
  const { laneConcurrency } = validateControllerRuntimeOptions(options);
  return {
    ...options,
    ...(laneConcurrency === undefined ? {} : { laneConcurrency }),
  };
}

function validatedMaxRounds(value: number | undefined): number {
  const maxRounds = value ?? DEFAULT_MAX_ROUNDS;
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) {
    throw new CueLineError("MAX_ROUNDS_INVALID", "maxRounds must be a positive integer.");
  }
  return maxRounds;
}

function validatedMaxJobEvidenceChars(value: number | undefined): number {
  const maximum = value ?? DEFAULT_MAX_JOB_EVIDENCE_CHARS;
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new CueLineError(
      "MAX_JOB_EVIDENCE_CHARS_INVALID",
      "maxJobEvidenceChars must be a positive integer.",
    );
  }
  return maximum;
}

function validatedMaxRepairAttempts(value: number | undefined): number {
  const maxRepairAttempts = value ?? DEFAULT_MAX_REPAIR_ATTEMPTS;
  if (!Number.isSafeInteger(maxRepairAttempts) || maxRepairAttempts < 0) {
    throw new CueLineError(
      "MAX_REPAIR_ATTEMPTS_INVALID",
      "maxRepairAttempts must be a non-negative integer.",
    );
  }
  return maxRepairAttempts;
}

function validatedArchivePolicy(value: boolean | undefined): boolean {
  if (value !== undefined && typeof value !== "boolean") {
    throw new CueLineError(
      "CONTROLLER_CONVERSATION_ARCHIVE_POLICY_INVALID",
      "archiveControllerConversationOnComplete must be a boolean.",
    );
  }
  return value === true;
}

function persistedMaxRounds(
  state: CueLineRunState,
  requested: number | undefined,
): number {
  const persisted = state.maxRounds ?? DEFAULT_MAX_ROUNDS;
  if (requested !== undefined && requested !== persisted) {
    throw new CueLineError(
      "RUN_MAX_ROUNDS_MISMATCH",
      `Run '${state.runId}' has a durable maxRounds limit of ${persisted}, not ${requested}.`,
      { details: { run_id: state.runId, max_rounds: persisted, requested_max_rounds: requested } },
    );
  }
  return persisted;
}

function persistedMaxJobEvidenceChars(
  state: CueLineRunState,
  requested: number | undefined,
): number {
  const persisted = state.maxJobEvidenceChars ?? DEFAULT_MAX_JOB_EVIDENCE_CHARS;
  if (requested !== undefined && requested !== persisted) {
    throw new CueLineError(
      "RUN_MAX_JOB_EVIDENCE_CHARS_MISMATCH",
      `Run '${state.runId}' has a durable maxJobEvidenceChars limit of ${persisted}, not ${requested}.`,
      {
        details: {
          run_id: state.runId,
          max_job_evidence_chars: persisted,
          requested_max_job_evidence_chars: requested,
        },
      },
    );
  }
  return persisted;
}

function persistedMaxRepairAttempts(
  state: CueLineRunState,
  requested: number | undefined,
): number {
  const persisted = state.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS;
  if (requested !== undefined && requested !== persisted) {
    throw new CueLineError(
      "RUN_MAX_REPAIR_ATTEMPTS_MISMATCH",
      `Run '${state.runId}' has a durable maxRepairAttempts limit of ${persisted}, not ${requested}.`,
      {
        details: {
          run_id: state.runId,
          max_repair_attempts: persisted,
          requested_max_repair_attempts: requested,
        },
      },
    );
  }
  return persisted;
}

function maxRoundsExceeded(maxRounds: number): CueLineError {
  return new CueLineError(
    "MAX_ROUNDS_EXCEEDED",
    `Controller did not finish within ${maxRounds} total rounds.`,
  );
}

function durableRoundLimitReached(state: CueLineRunState, maxRounds: number): boolean {
  return (
    state.lastFailure?.code === "MAX_ROUNDS_EXCEEDED" && state.round >= maxRounds
  );
}

async function controllerEvidenceJobs(
  store: RunStore<CueLineRunState>,
): Promise<ReturnType<typeof jobObservations>> {
  const observations = jobObservations(store.state);
  const statusStore = new JobStatusStore(store.paths.home);
  const capObservation = (
    observation: (typeof observations)[number],
    output = observation.output,
    error = observation.error,
    replayingRunEvent = false,
  ): (typeof observations)[number] => {
    const cappedOutput =
      output === undefined
        ? undefined
        : replayingRunEvent
          ? capReplayedControllerEvidence(
              output,
              observation.output_total_chars,
              store.state.maxJobEvidenceChars,
            )
          : capControllerEvidence(output, store.state.maxJobEvidenceChars);
    const cappedError =
      error === undefined
        ? undefined
        : replayingRunEvent
          ? capReplayedControllerEvidence(
              error,
              observation.error_total_chars,
              store.state.maxJobEvidenceChars,
            )
          : capControllerEvidence(error, store.state.maxJobEvidenceChars);
    return {
      ...observation,
      ...(cappedOutput === undefined
        ? {}
        : {
            output: cappedOutput.value,
            output_total_chars: Math.max(
              cappedOutput.totalChars,
              observation.output_total_chars ?? 0,
            ),
          }),
      ...(cappedError === undefined
        ? {}
        : {
            error: cappedError.value,
            error_total_chars: Math.max(
              cappedError.totalChars,
              observation.error_total_chars ?? 0,
            ),
          }),
    };
  };
  return Promise.all(
    observations.map(async (observation) => {
      const job = store.state.jobs[observation.job_id];
      try {
        const persisted = await statusStore.read(observation.job_id);
        if (
          persisted === undefined ||
          persisted.status !== observation.status ||
          (persisted.runId !== undefined && persisted.runId !== store.runId) ||
          (persisted.jobKey !== undefined && persisted.jobKey !== job?.jobKey)
        ) {
          return capObservation(
            observation,
            observation.output,
            observation.error,
            true,
          );
        }
        const output = controllerResultOutput(persisted);
        return capObservation(observation, output, persisted.error);
      } catch {
        return capObservation(
          observation,
          observation.output,
          observation.error,
          true,
        );
      }
    }),
  );
}

async function driveControllerLoop(
  store: RunStore<CueLineRunState>,
  options: ControllerRuntimeOptions,
): Promise<CueLineResult> {
  const { maxRounds, maxRepairAttempts } = validateControllerRuntimeOptions(options);
  const id = store.runId;
  for (;;) {
    throwIfCancelled(options.signal);
    const state = store.state;
    if (state.round >= maxRounds) {
      throw maxRoundsExceeded(maxRounds);
    }
    const round = state.round + 1;
    const evidenceJobs = await controllerEvidenceJobs(store);
    const notSentRetry =
      state.notSentRecovery?.status === "confirmed" &&
      state.notSentRecovery.retryRequestId === null
        ? state.notSentRecovery
        : undefined;
    const requestId = messageId(id, round, "observation", {
      jobs: evidenceJobs,
      notices: state.notices,
      ...(notSentRetry === undefined
        ? {}
        : {
            not_sent_retry_of_request_id: notSentRetry.abandonedRequestId,
            not_sent_retry_prompt_hash: notSentRetry.promptHash,
          }),
    });
    const observation = observationFor(state, round, requestId, evidenceJobs);
    const command = await requestControllerCommand(
      store,
      options.browser,
      observation,
      { runId: id, round, requestId },
      maxRepairAttempts,
      options.controllerInstructions ?? [],
      undefined,
      (candidate) => validateCommandBeforeAcceptance(store, candidate, options, evidenceJobs),
      options.signal,
      undefined,
      options.returnAfterControllerSubmission === true,
      notSentRetry,
    );
    if (command === undefined) {
      await store.snapshot();
      return awaitingControllerResult(store.state);
    }
    const acceptedCommandHash = commandHash(command);
    await store.append("controller_command_accepted", {
      command,
      command_hash: acceptedCommandHash,
    });
    const outcome = await executeAcceptedCommand(
      store,
      command,
      acceptedCommandHash,
      options,
    );
    await store.snapshot();
    if (outcome === "terminal") {
      return resultFromState(store.state);
    }
    if (outcome === "awaiting_caller") return awaitingCallerResult(store.state);
  }
}

async function reconcilePendingControllerTurn(
  store: RunStore<CueLineRunState>,
  options: ContinueControllerLoopOptions,
): Promise<CommandExecutionOutcome> {
  const pendingTurns = store.state.pendingControllerTurns ?? [];
  if (pendingTurns.length === 0) return "continue";
  const provenUnsent =
    pendingTurns.length === 1 &&
    isControllerTurnProvenUnsent(store.state, pendingTurns[0]);
  if (provenUnsent) {
    const pending = pendingTurns[0]!;
    await store.append("controller_turn_abandoned", {
      round: pending.round,
      request_id: pending.requestId,
      reason: "definitely_not_sent_retry",
      round_not_consumed: true,
    });
    return "continue";
  }
  if (pendingTurns.length > 1 && options.reconcileRequestId === undefined) {
    throw new CueLineError(
      "MULTIPLE_CONTROLLER_TURNS_PENDING",
      "More than one controller turn lacks a recorded response. Select the exact requestId to reconcile; CueLine will not guess.",
      {
        details: {
          stage: "reconciling",
          submission_state: "possibly_sent",
          request_ids: pendingTurns.map((turn) => turn.requestId),
        },
      },
    );
  }
  const pending =
    options.reconcileRequestId === undefined
      ? pendingTurns[0]!
      : pendingTurns.find((turn) => turn.requestId === options.reconcileRequestId);
  if (!pending) {
    throw new CueLineError(
      "CONTROLLER_RECONCILIATION_REQUEST_NOT_FOUND",
      `Pending controller request '${options.reconcileRequestId}' was not found.`,
      { details: { stage: "reconciling", submission_state: "possibly_sent" } },
    );
  }
  const expectedConversationUrl = assertConversationUrlCompatible(
    store.state,
    options.conversationUrl,
    pending,
  );
  const shouldRecordTurnBinding = pending.conversationUrl === null;
  const otherPending = pendingTurns.filter((turn) => turn.requestId !== pending.requestId);
  if (otherPending.length > 0 && options.abandonOtherPendingTurns !== true) {
    throw new CueLineError(
      "OTHER_CONTROLLER_TURNS_PENDING",
      "Other controller turns still lack recorded responses. Set abandonOtherPendingTurns only after explicitly choosing which existing response is authoritative.",
      {
        details: {
          stage: "reconciling",
          submission_state: "possibly_sent",
          request_ids: otherPending.map((turn) => turn.requestId),
        },
      },
    );
  }
  const observeSubmittedTurn =
    pending.retryOfRequestId === undefined || pending.retryOfRequestId === null
      ? options.browser.observeSubmittedTurn
      : undefined;
  const observeWithoutWaiting =
    observeSubmittedTurn !== undefined || options.browser.observeTurn !== undefined;
  if (!observeWithoutWaiting && !options.browser.recoverTurn) {
    throw new CueLineError(
      "CONTROLLER_RECONCILIATION_REQUIRED",
      "This run has a pending controller turn whose submission outcome is unknown. The browser adapter must recover the existing response without sending.",
      {
        details: {
          stage: "reconciling",
          submission_state: pending.submissionState,
        },
      },
    );
  }
  const state = store.state;
  const evidenceJobs = await controllerEvidenceJobs(store);
  const observation = observationFor(
    state,
    pending.round,
    pending.requestId,
    evidenceJobs,
  );
  const recoveryInput = {
    runId: state.runId,
    round: pending.round,
    requestId: pending.requestId,
    prompt: pending.prompt,
    ...(pending.manualSendConfirmed ? { manualSendConfirmed: true } : {}),
    ...(pending.composerPromptState === "attachment_ready"
      ? { attachmentPromptExpected: true }
      : {}),
    ...(pending.baselineUserMessageCount === null ||
    pending.baselineUserMessageCount === undefined
      ? {}
      : { baselineUserMessageCount: pending.baselineUserMessageCount }),
    ...(pending.baselineAssistantMessageCount === null
      ? {}
      : { baselineAssistantMessageCount: pending.baselineAssistantMessageCount }),
    ...(pending.retryOfRequestId === undefined ||
    pending.retryOfRequestId === null ||
    state.notSentRecovery?.abandonedRequestId !== pending.retryOfRequestId
      ? {}
      : {
          notSentRecovery: {
            abandonedRequestId: state.notSentRecovery.abandonedRequestId,
            promptHash: state.notSentRecovery.promptHash,
            conversationUrl: state.notSentRecovery.conversationUrl,
            baselineUserMessageCount:
              state.notSentRecovery.baselineUserMessageCount ?? 0,
          },
        }),
    ...(pending.repairAttempt === 0 ? {} : { repairAttempt: pending.repairAttempt }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  let turn;
  if (
    observeSubmittedTurn !== undefined &&
    expectedConversationUrl !== null &&
    isSubmittedTurnRecoveryCandidate(pending, expectedConversationUrl)
  ) {
    const submittedObservation = await observeSubmittedTurn.call(
      options.browser,
      recoveryInput,
    );
    if (submittedObservation.status === "pending") return "awaiting_controller";
    if (submittedObservation.status === "definitely_not_sent") {
      if (
        !isDefinitelyNotSentObservation(
          pending,
          expectedConversationUrl,
          submittedObservation.evidence,
        )
      ) {
        return "awaiting_controller";
      }
      await recordFreshSubmittedTurnNotSent(
        store,
        pending,
        submittedObservation.evidence,
      );
      return "continue";
    }
    turn = submittedObservation.turn;
  } else {
    turn = options.browser.observeTurn
      ? await options.browser.observeTurn(recoveryInput)
      : await options.browser.recoverTurn!(recoveryInput);
  }
  if (turn === undefined) return "awaiting_controller";
  const command = await requestControllerCommand(
    store,
    options.browser,
    observation,
    { runId: state.runId, round: pending.round, requestId: pending.requestId },
    options.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS,
    options.controllerInstructions ?? [],
    {
      turn,
      attempt: pending.repairAttempt,
      ...(pending.manualSendConfirmed ? { manualSendConfirmed: true } : {}),
    },
    (candidate) => validateCommandBeforeAcceptance(store, candidate, options, evidenceJobs),
    options.signal,
    expectedConversationUrl,
    options.returnAfterControllerSubmission === true,
  );
  if (command === undefined) return "awaiting_controller";
  if (shouldRecordTurnBinding && store.state.conversationUrl !== null) {
    await store.append("controller_conversation_bound", {
      request_id: pending.requestId,
      conversation_url: store.state.conversationUrl,
    });
  }
  for (const abandoned of otherPending) {
    await store.append("controller_turn_abandoned", {
      round: abandoned.round,
      request_id: abandoned.requestId,
      reason: "operator_selected_existing_response",
    });
  }
  const acceptedCommandHash = commandHash(command);
  await store.append("controller_command_accepted", {
    command,
    command_hash: acceptedCommandHash,
  });
  return executeAcceptedCommand(
    store,
    command,
    acceptedCommandHash,
    options,
  );
}

async function recordFreshSubmittedTurnNotSent(
  store: RunStore<CueLineRunState>,
  pending: CueLineRunState["pendingControllerTurns"][number],
  evidence: BrowserSubmittedTurnEvidence,
): Promise<void> {
  if (store.state.notSentRecovery?.abandonedRequestId !== pending.requestId) {
    await store.append("controller_turn_not_sent_confirmed", {
      round: pending.round,
      request_id: pending.requestId,
      prompt_hash: pending.promptHash,
      conversation_url: evidence.conversationUrl,
      selected_model_label: evidence.selectedModelLabel,
      baseline_user_message_count: evidence.baselineUserMessageCount,
      observed_user_message_count: evidence.observedUserMessageCount,
      request_message_found: false,
      is_answering: false,
      page_hydrated: true,
      submission_state: "definitely_not_sent",
      confirmation_source: "fresh_read_only_observation",
      operator_confirmation: false,
    });
  }
  if (
    (store.state.pendingControllerTurns ?? []).some(
      (turn) => turn.requestId === pending.requestId,
    )
  ) {
    await store.append("controller_turn_abandoned", {
      round: pending.round,
      request_id: pending.requestId,
      reason: "fresh_observation_definitely_not_sent",
      round_not_consumed: true,
      prompt_hash: pending.promptHash,
      conversation_url: evidence.conversationUrl,
      selected_model_label: evidence.selectedModelLabel,
      baseline_user_message_count: evidence.baselineUserMessageCount,
      observed_user_message_count: evidence.observedUserMessageCount,
      request_message_found: false,
      is_answering: false,
      page_hydrated: true,
      submission_state: "definitely_not_sent",
      confirmation_source: "fresh_read_only_observation",
      operator_confirmation: false,
    });
  }
}

async function createControllerRunStore(
  options: CreateControllerRunOptions,
): Promise<RunStore<CueLineRunState>> {
  if (options.request.trim() === "") {
    throw new CueLineError("REQUEST_EMPTY", "CueLine requires a non-empty request.");
  }
  const now = options.now ?? (() => new Date());
  const id =
    options.runId ??
    createRunId({ request: options.request, created_at: now().toISOString(), nonce: randomUUID() });
  const executor = options.executor ?? "caller";
  const allowProcessExecution = options.allowProcessExecution === true;
  if (executor === "process" && !allowProcessExecution) {
    throw new CueLineError(
      "PROCESS_EXECUTION_NOT_AUTHORIZED",
      "Process execution requires both executor='process' and allowProcessExecution=true.",
    );
  }
  const maxRounds = validatedMaxRounds(options.maxRounds);
  const maxJobEvidenceChars = validatedMaxJobEvidenceChars(options.maxJobEvidenceChars);
  const maxRepairAttempts = validatedMaxRepairAttempts(options.maxRepairAttempts);
  const archiveControllerConversationOnComplete = validatedArchivePolicy(
    options.archiveControllerConversationOnComplete,
  );
  const initial = initialRunState(
    id,
    options.request,
    executor,
    maxRounds,
    allowProcessExecution,
    archiveControllerConversationOnComplete,
    maxJobEvidenceChars,
    maxRepairAttempts,
  );
  const home = options.home ?? defaultCueLineHome();
  const store = await RunStore.createWithInitialEvent({
    home,
    runId: id,
    initialState: initial,
    reducer: reduceRunState,
    now,
  }, "run_created", {
    request: options.request,
    executor,
    ...(allowProcessExecution ? { allow_process_execution: true } : {}),
    ...(options.maxRounds === undefined ? {} : { max_rounds: maxRounds }),
    ...(options.maxJobEvidenceChars === undefined
      ? {}
      : { max_job_evidence_chars: maxJobEvidenceChars }),
    ...(options.maxRepairAttempts === undefined
      ? {}
      : { max_repair_attempts: maxRepairAttempts }),
    ...(archiveControllerConversationOnComplete
      ? { archive_controller_conversation_on_complete: true }
      : {}),
  });
  await store.snapshot();
  return store;
}

export async function createControllerRun(
  options: CreateControllerRunOptions,
): Promise<CueLineResult> {
  return readyResult((await createControllerRunStore(options)).state);
}

export async function runControllerLoop(options: ControllerLoopOptions): Promise<CueLineResult> {
  options = validatedRuntimeOptions(options);
  const store = await createControllerRunStore(options);
  const now = options.now ?? (() => new Date());
  const id = store.runId;
  const home = options.home ?? defaultCueLineHome();
  let lease: RuntimeLease;
  try {
    lease = await RuntimeLease.claim({
      home,
      runId: id,
      now,
      ...(options.runtimeHeartbeatIntervalMs === undefined
        ? {}
        : { heartbeatIntervalMs: options.runtimeHeartbeatIntervalMs }),
    });
  } catch (error) {
    // The run_created event is already durable, but no owner was acquired.
    // Enrich the failure for exact recovery without inventing an unowned
    // run_failed transition.
    throw postCreateFailure(error, id);
  }
  store.bindRuntimeOwner(lease.ownerId);
  let cancellation: OwnedCancellation | undefined;
  try {
    const ownedSignal =
      options.signal === undefined
        ? lease.signal
        : AbortSignal.any([options.signal, lease.signal]);
    cancellation = watchOwnedCancellation(home, id, { ...options, signal: ownedSignal });
    if (options.conversationUrl) {
      await store.append("controller_conversation_bound", {
        conversation_url: options.conversationUrl,
      });
    }
    const result = await driveControllerLoop(store, cancellation.options);
    lease.assertHealthy();
    return result;
  } catch (error) {
    return await handleControllerFailure(store, options.jobSupervisor, error);
  } finally {
    try {
      await cancellation?.stop();
    } finally {
      await lease.release();
    }
  }
}

export async function continueControllerLoop(
  options: ContinueControllerLoopOptions,
): Promise<CueLineResult> {
  options = validatedRuntimeOptions(options);
  const now = options.now ?? (() => new Date());
  const home = options.home ?? defaultCueLineHome();
  const initialStore = await RunStore.load({
    home,
    runId: options.runId,
    initialState: initialRunState(options.runId, ""),
    reducer: reduceRunState,
    now,
  });
  const initialState = initialStore.state;
  if (initialState.request === "") {
    throw new CueLineError("RUN_NOT_FOUND", `No persisted CueLine run '${options.runId}' was found.`);
  }
  if (
    options.archiveControllerConversationOnComplete !== undefined &&
    options.archiveControllerConversationOnComplete !==
      (initialState.controllerConversationArchive?.enabled ?? false)
  ) {
    throw new CueLineError(
      "CONTROLLER_CONVERSATION_ARCHIVE_POLICY_MISMATCH",
      `Run '${options.runId}' has a different durable controller conversation archive policy.`,
    );
  }
  const recoverControllerArchive = controllerConversationArchiveNeedsRecovery(initialState);
  if (
    initialState.status === "complete" ||
    initialState.status === "blocked" ||
    initialState.status === "cancelled"
  ) {
    if (!recoverControllerArchive) return resultFromState(initialState);
  }
  if (
    !recoverControllerArchive &&
    initialState.executor === "process" &&
    (!initialState.allowProcessExecution || options.allowProcessExecution !== true)
  ) {
    throw new CueLineError(
      "PROCESS_EXECUTION_NOT_AUTHORIZED",
      "Continuing a process run requires durable authorization and allowProcessExecution=true on this call.",
    );
  }
  const maxRounds = persistedMaxRounds(initialState, options.maxRounds);
  persistedMaxJobEvidenceChars(initialState, options.maxJobEvidenceChars);
  const maxRepairAttempts = persistedMaxRepairAttempts(initialState, options.maxRepairAttempts);
  if (durableRoundLimitReached(initialState, maxRounds)) {
    throw maxRoundsExceeded(maxRounds);
  }
  const initialRuntime = await readRuntimeLease(home, options.runId, { now });
  const initialCancellation = await readCancellationObservation(home, options.runId);
  const recoverStaleObserver = isSafeStaleCallerObservationRecovery(
    initialState,
    initialRuntime,
    initialCancellation,
  );
  if (
    recoverControllerArchive &&
    initialRuntime.ownership !== "missing" &&
    initialRuntime.ownership !== "released"
  ) {
    throw new CueLineError(
      "RUN_OWNERSHIP_UNVERIFIED",
      "The completed run's archive recovery requires a missing or released runtime owner.",
    );
  }
  if (!recoverStaleObserver && !recoverControllerArchive) {
    assertRunCanContinue(initialState, initialRuntime, initialCancellation);
  }
  const lease = recoverStaleObserver
    ? await RuntimeLease.takeoverStale({
        home,
        runId: options.runId,
        now,
        expectedOwnerId: initialRuntime.ownerId!,
        expectedHeartbeatAt: initialRuntime.heartbeatAt!,
        ...(options.runtimeHeartbeatIntervalMs === undefined
          ? {}
          : { heartbeatIntervalMs: options.runtimeHeartbeatIntervalMs }),
      })
    : await RuntimeLease.claim({
        home,
        runId: options.runId,
        now,
        ...(options.runtimeHeartbeatIntervalMs === undefined
          ? {}
          : { heartbeatIntervalMs: options.runtimeHeartbeatIntervalMs }),
      });
  let cancellation: OwnedCancellation | undefined;
  let store = initialStore;
  try {
    store = await RunStore.load({
      home,
      runId: options.runId,
      initialState: initialRunState(options.runId, ""),
      reducer: reduceRunState,
      now,
    });
    store.bindRuntimeOwner(lease.ownerId);
    const state = store.state;
    if (state.request === "") {
      throw new CueLineError(
        "RUN_NOT_FOUND",
        `No persisted CueLine run '${options.runId}' was found.`,
      );
    }
    if (
      state.status === "complete" ||
      state.status === "blocked" ||
      state.status === "cancelled"
    ) {
      assertConversationUrlCompatible(state, options.conversationUrl);
      if (controllerConversationArchiveNeedsRecovery(state)) {
        await settleControllerConversationArchive(store, options);
      }
      return resultFromState(store.state);
    }
    assertConversationUrlCompatible(state, options.conversationUrl);
    const cancellationObservation = await readCancellationObservation(home, options.runId);
    if (cancellationObservation.runRequested) {
      throw new CueLineError(
        "RUN_CANCELLED",
        "A durable run cancellation was requested before continuation acquired ownership.",
        { details: { run_id: options.runId } },
      );
    }
    const ownedSignal =
      options.signal === undefined
        ? lease.signal
        : AbortSignal.any([options.signal, lease.signal]);
    cancellation = watchOwnedCancellation(home, options.runId, {
      ...options,
      maxRounds,
      maxRepairAttempts,
      signal: ownedSignal,
    });
    if (recoverStaleObserver) {
      const pending = state.pendingControllerTurns[0]!;
      await store.append("runtime_stale_caller_observer_recovered", {
        previous_owner_id: initialRuntime.ownerId,
        previous_heartbeat_at: initialRuntime.heartbeatAt,
        request_id: pending.requestId,
        round: pending.round,
        conversation_url: pending.conversationUrl ?? state.conversationUrl,
        recovery: "fenced_read_only_observation",
      });
    }
    await store.append("run_resumed", { previous_status: state.status });
    await store.snapshot();
    const pendingCommandExecution = store.state.pendingCommandExecution ?? null;
    if (pendingCommandExecution !== null) {
      const outcome = await executeAcceptedCommand(
        store,
        pendingCommandExecution.command,
        pendingCommandExecution.commandHash,
        cancellation.options,
        true,
      );
      await store.snapshot();
      if (outcome === "terminal") return resultFromState(store.state);
      if (outcome === "awaiting_controller") return awaitingControllerResult(store.state);
      if (outcome === "awaiting_caller") return awaitingCallerResult(store.state);
    }
    if (
      (options.executor ?? store.state.executor) === "caller" &&
      Object.values(store.state.jobs).some(
        (job) => job.status === "pending" || job.status === "running",
      )
    ) {
      return awaitingCallerResult(store.state);
    }
    if ((store.state.pendingControllerTurns ?? []).length > 0) {
      const outcome = await reconcilePendingControllerTurn(store, {
        ...options,
        maxRepairAttempts,
        signal: cancellation.options.signal,
      });
      await store.snapshot();
      if (outcome === "terminal") return resultFromState(store.state);
      if (outcome === "awaiting_controller") return awaitingControllerResult(store.state);
      if (outcome === "awaiting_caller") return awaitingCallerResult(store.state);
    } else if (options.conversationUrl) {
      await store.append("controller_conversation_bound", {
        conversation_url: options.conversationUrl,
      });
    }
    const result = await driveControllerLoop(store, cancellation.options);
    lease.assertHealthy();
    return result;
  } catch (error) {
    return await handleControllerFailure(store, options.jobSupervisor, error);
  } finally {
    try {
      await cancellation?.stop();
    } finally {
      await lease.release();
    }
  }
}
