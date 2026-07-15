import { randomUUID } from "node:crypto";

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
  executeAcceptedCommand,
  statusPayload,
  validateCommandBeforeAcceptance,
  type CommandExecutionOutcome,
} from "./controller-command-execution.js";
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
  DEFAULT_MAX_ROUNDS,
  initialRunState,
  isControllerTurnProvenUnsent,
  jobObservations,
  reduceRunState,
  type CueLineRunState,
} from "./state-machine.js";

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
          : statusPayload(status),
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
  | "maxRepairAttempts"
  | "runTimeoutMs"
  | "cancellationPollIntervalMs"
  | "runtimeHeartbeatIntervalMs"
  | "maxConcurrency"
  | "laneConcurrency"
>;

export function validateControllerRuntimeOptions(options: ControllerRuntimeLimitOptions): {
  maxRounds: number;
  maxRepairAttempts: number;
} {
  const maxRounds = validatedMaxRounds(options.maxRounds);
  const maxRepairAttempts = options.maxRepairAttempts ?? 2;
  if (!Number.isSafeInteger(maxRepairAttempts) || maxRepairAttempts < 0) {
    throw new CueLineError(
      "MAX_REPAIR_ATTEMPTS_INVALID",
      "maxRepairAttempts must be a non-negative integer.",
    );
  }
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
  for (const [lane, limit] of Object.entries(options.laneConcurrency ?? {})) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new CueLineError(
        "LANE_CONCURRENCY_INVALID",
        `laneConcurrency['${lane}'] must be a positive integer.`,
      );
    }
  }
  return { maxRounds, maxRepairAttempts };
}

function validatedMaxRounds(value: number | undefined): number {
  const maxRounds = value ?? DEFAULT_MAX_ROUNDS;
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) {
    throw new CueLineError("MAX_ROUNDS_INVALID", "maxRounds must be a positive integer.");
  }
  return maxRounds;
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
          return observation;
        }
        const output = controllerResultOutput(persisted);
        return {
          ...observation,
          ...(output === undefined ? {} : { output }),
          ...(persisted.error === undefined ? {} : { error: persisted.error }),
        };
      } catch {
        return observation;
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
    const requestId = messageId(id, round, "observation", {
      jobs: evidenceJobs,
      notices: state.notices,
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
  const observeWithoutWaiting =
    options.browser.observeTurn !== undefined;
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
    ...(pending.baselineAssistantMessageCount === null
      ? {}
      : { baselineAssistantMessageCount: pending.baselineAssistantMessageCount }),
    ...(pending.repairAttempt === 0 ? {} : { repairAttempt: pending.repairAttempt }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const turn = observeWithoutWaiting
    ? await options.browser.observeTurn!(recoveryInput)
    : await options.browser.recoverTurn!(recoveryInput);
  if (turn === undefined) return "awaiting_controller";
  const command = await requestControllerCommand(
    store,
    options.browser,
    observation,
    { runId: state.runId, round: pending.round, requestId: pending.requestId },
    options.maxRepairAttempts ?? 2,
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
  const initial = initialRunState(
    id,
    options.request,
    executor,
    maxRounds,
    allowProcessExecution,
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
  validateControllerRuntimeOptions(options);
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
  validateControllerRuntimeOptions(options);
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
    initialState.status === "complete" ||
    initialState.status === "blocked" ||
    initialState.status === "cancelled"
  ) {
    return resultFromState(initialState);
  }
  if (
    initialState.executor === "process" &&
    (!initialState.allowProcessExecution || options.allowProcessExecution !== true)
  ) {
    throw new CueLineError(
      "PROCESS_EXECUTION_NOT_AUTHORIZED",
      "Continuing a process run requires durable authorization and allowProcessExecution=true on this call.",
    );
  }
  const maxRounds = persistedMaxRounds(initialState, options.maxRounds);
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
  if (!recoverStaleObserver) {
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
      return resultFromState(state);
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
