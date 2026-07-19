import type {
  CueLineCallerJobSubmissionOptions,
  CueLineCallerJobResultInput,
  CueLineCallerJobSubmissionResult,
  CueLineCallerWorkClaimProof,
  ControllerNotSentConfirmation,
  CueLineRuntimeOptions,
  ManualControllerSubmissionConfirmation,
} from "./api-contracts.js";
import type { BrowserSubmittedTurnEvidence } from "./browser/browser-adapter.js";
import { validateCallerWorkResultClaim } from "./api-caller-work.js";
import { boundedControllerEventEvidence } from "./core/controller-turn.js";
import {
  isExactChatGptConversationUrl,
  sameChatGptConversationUrl,
} from "./core/conversation-url.js";
import { CueLineError } from "./core/errors.js";
import { loadPersistedRunStore } from "./core/persisted-run.js";
import { runtimeEnvironment } from "./core/runtime.js";
import { JobStatusStore, type JobStatus } from "./jobs/status.js";
import { defaultCueLineHome } from "./state/paths.js";
import {
  readRuntimeLease,
  retireDeadRuntimeLease,
  RuntimeLease,
} from "./state/runtime-lease.js";
import { readAuthoritativeRunEvents } from "./state/store.js";
import { readCancellationObservation } from "./state/cancellation.js";
import {
  isDefinitelyNotSentObservation,
  isSubmittedTurnRecoveryCandidate,
} from "./core/submitted-turn-recovery.js";

type AuthoritativeRunEvent = Awaited<ReturnType<typeof readAuthoritativeRunEvents>>[number];

function eventPayload(event: AuthoritativeRunEvent): Record<string, unknown> {
  return typeof event.payload === "object" &&
    event.payload !== null &&
    !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : {};
}

function isLegacyPreSubmissionAdapterFailure(
  events: readonly AuthoritativeRunEvent[],
  turn: {
    requestId: string;
    round: number;
    submissionState: string;
    selectedModelLabel?: string | null | undefined;
    baselineUserMessageCount?: number | null | undefined;
    baselineAssistantMessageCount?: number | null | undefined;
    baselineLastUserMessageHash?: string | null | undefined;
    composerPromptState?: string | null | undefined;
    submissionCheckpointContract?: string | null | undefined;
  },
): boolean {
  if (
    turn.submissionState !== "possibly_sent" ||
    turn.selectedModelLabel !== null ||
    turn.baselineUserMessageCount !== null ||
    turn.baselineAssistantMessageCount !== null ||
    turn.baselineLastUserMessageHash !== null ||
    turn.composerPromptState !== null ||
    turn.submissionCheckpointContract !== null
  ) {
    return false;
  }
  const requestedIndexes = events.flatMap((event, index) => {
    const payload = eventPayload(event);
    return event.type === "controller_turn_requested" &&
      payload.request_id === turn.requestId &&
      payload.round === turn.round
      ? [index]
      : [];
  });
  if (requestedIndexes.length !== 1) return false;
  const requestedIndex = requestedIndexes[0]!;
  const immediateFailure = events[requestedIndex + 1];
  if (immediateFailure?.type !== "run_failed") return false;
  const failure = eventPayload(immediateFailure);
  if (
    failure.code !== "CUELINE_INTERNAL" ||
    failure.message !== "browser.sendTurn is not a function" ||
    failure.request_id !== turn.requestId ||
    failure.stage !== "controller_turn" ||
    failure.submission_state !== "requested"
  ) {
    return false;
  }
  return !events.slice(requestedIndex + 1).some((event) => {
    const payload = eventPayload(event);
    if (
      (event.type === "controller_turn_submission_started" ||
        event.type === "controller_turn_submitted" ||
        event.type === "controller_response_received") &&
      payload.request_id === turn.requestId
    ) {
      return true;
    }
    if (event.type !== "controller_command_accepted") return false;
    const command =
      typeof payload.command === "object" &&
      payload.command !== null &&
      !Array.isArray(payload.command)
        ? (payload.command as Record<string, unknown>)
        : {};
    return (
      command.request_id === turn.requestId ||
      (typeof command.round === "number" && command.round >= turn.round)
    );
  });
}

function isLegacyDefinitelyNotSentObservation(
  evidence: BrowserSubmittedTurnEvidence,
  conversationUrl: string,
): boolean {
  return (
    sameChatGptConversationUrl(evidence.conversationUrl, conversationUrl) &&
    /^Pro(?:\s|$)/i.test(evidence.selectedModelLabel ?? "") &&
    evidence.hydrated === true &&
    evidence.requestMessageFound === false &&
    evidence.isAnswering === false &&
    evidence.observedUserMessageCount !== null
  );
}

export async function confirmManualControllerSubmission(
  runId: string,
  options: Pick<CueLineRuntimeOptions, "home" | "environment" | "now"> & {
    requestId: string;
    conversationUrl?: string;
  },
): Promise<ManualControllerSubmissionConfirmation> {
  const environment = options.environment ?? runtimeEnvironment();
  const home = options.home ?? defaultCueLineHome(environment);
  await loadPersistedRunStore(home, runId);
  const runtime = await readRuntimeLease(home, runId, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const retiredOwner =
    (runtime.ownership === "active" || runtime.ownership === "stale") &&
    runtime.ownerId !== undefined &&
    (await retireDeadRuntimeLease(home, runId, runtime.ownerId))
      ? { ownerId: runtime.ownerId, ownership: runtime.ownership }
      : undefined;
  const lease = await RuntimeLease.claim({
    home,
    runId,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  try {
    const store = await loadPersistedRunStore(home, runId);
    store.bindRuntimeOwner(lease.ownerId);
    if (retiredOwner !== undefined) {
      await store.append("runtime_dead_owner_retired", {
        owner_id: retiredOwner.ownerId,
        previous_ownership: retiredOwner.ownership,
      });
    }
    const state = store.state;
    const turn =
      (state.pendingControllerTurns ?? []).find(
        (candidate) => candidate.requestId === options.requestId,
      ) ??
      (state.abandonedControllerTurns ?? []).find(
        (candidate) => candidate.requestId === options.requestId,
      );
    if (!turn) {
      throw new CueLineError(
        "CONTROLLER_RECONCILIATION_REQUEST_NOT_FOUND",
        `Controller request '${options.requestId}' is neither pending nor recoverably abandoned in run '${runId}'.`,
      );
    }
    const suppliedConversationUrl =
      options.conversationUrl ?? turn.conversationUrl ?? state.conversationUrl;
    if (!isExactChatGptConversationUrl(suppliedConversationUrl)) {
      throw new CueLineError(
        "CONTROLLER_RECONCILIATION_URL_REQUIRED",
        "Manual submission confirmation requires the exact ChatGPT conversation URL.",
      );
    }
    if (
      state.conversationUrl !== null &&
      !sameChatGptConversationUrl(suppliedConversationUrl, state.conversationUrl)
    ) {
      throw new CueLineError(
        "CONTROLLER_RECONCILIATION_CONVERSATION_MISMATCH",
        "The operator-confirmed conversation URL does not match the persisted CueLine conversation.",
      );
    }
    if (
      turn.conversationUrl !== null &&
      !sameChatGptConversationUrl(suppliedConversationUrl, turn.conversationUrl)
    ) {
      throw new CueLineError(
        "CONTROLLER_RECONCILIATION_CONVERSATION_MISMATCH",
        "The operator-confirmed conversation URL does not match the exact conversation bound to this controller turn.",
      );
    }
    const conversationUrl =
      state.conversationUrl ?? turn.conversationUrl ?? suppliedConversationUrl;
    const events = await readAuthoritativeRunEvents(home, runId);
    for (const event of events) {
      if (event.type !== "controller_command_accepted") continue;
      const payload =
        typeof event.payload === "object" &&
        event.payload !== null &&
        !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>)
          : {};
      const command =
        typeof payload.command === "object" &&
        payload.command !== null &&
        !Array.isArray(payload.command)
          ? (payload.command as Record<string, unknown>)
          : {};
      const acceptedRequestId = command.request_id;
      const acceptedRound = command.round;
      if (
        acceptedRequestId === options.requestId ||
        (typeof acceptedRound === "number" && acceptedRound >= turn.round)
      ) {
        throw new CueLineError(
          "CONTROLLER_RECONCILIATION_SUPERSEDED",
          "A command for this request or the same/newer controller round was already accepted; refusing duplicate reconciliation.",
        );
      }
    }
    if (state.conversationUrl === null) {
      await store.append("controller_conversation_bound", {
        request_id: turn.requestId,
        conversation_url: conversationUrl,
        operator_confirmation: true,
      });
    }
    if (turn.manualSendConfirmed) {
      return {
        runId,
        requestId: turn.requestId,
        conversationUrl,
        outcome: "already_confirmed",
      };
    }
    await store.append("controller_turn_manual_submission_confirmed", {
      round: turn.round,
      request_id: turn.requestId,
      conversation_url: conversationUrl,
      operator_confirmation: true,
    });
    await store.snapshot();
    return { runId, requestId: turn.requestId, conversationUrl, outcome: "confirmed" };
  } finally {
    await lease.release();
  }
}

export async function confirmControllerTurnNotSent(
  runId: string,
  options: Pick<
    CueLineRuntimeOptions,
    "home" | "environment" | "now" | "browser"
  > & {
    requestId: string;
    conversationUrl?: string;
  },
): Promise<ControllerNotSentConfirmation> {
  const environment = options.environment ?? runtimeEnvironment();
  const home = options.home ?? defaultCueLineHome(environment);
  await loadPersistedRunStore(home, runId);
  const runtime = await readRuntimeLease(home, runId, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const retiredOwner =
    (runtime.ownership === "active" || runtime.ownership === "stale") &&
    runtime.ownerId !== undefined &&
    (await retireDeadRuntimeLease(home, runId, runtime.ownerId))
      ? { ownerId: runtime.ownerId, ownership: runtime.ownership }
      : undefined;
  const lease = await RuntimeLease.claim({
    home,
    runId,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  try {
    const store = await loadPersistedRunStore(home, runId);
    store.bindRuntimeOwner(lease.ownerId);
    if (retiredOwner !== undefined) {
      await store.append("runtime_dead_owner_retired", {
        owner_id: retiredOwner.ownerId,
        previous_ownership: retiredOwner.ownership,
      });
    }
    const state = store.state;
    const existingRecovery =
      state.notSentRecovery?.abandonedRequestId === options.requestId
        ? state.notSentRecovery
        : null;
    const turn = (state.pendingControllerTurns ?? []).find(
      (candidate) => candidate.requestId === options.requestId,
    );
    if (turn === undefined) {
      if (existingRecovery !== null) {
        return {
          runId,
          requestId: options.requestId,
          conversationUrl: existingRecovery.conversationUrl,
          promptHash: existingRecovery.promptHash,
          outcome: "already_confirmed",
        };
      }
      throw new CueLineError(
        "CONTROLLER_RECONCILIATION_REQUEST_NOT_FOUND",
        `Pending controller request '${options.requestId}' was not found.`,
      );
    }
    if ((state.pendingControllerTurns ?? []).length !== 1) {
      throw new CueLineError(
        "OTHER_CONTROLLER_TURNS_PENDING",
        "Operator-confirmed not-sent recovery requires exactly one pending controller turn.",
      );
    }
    const cancellation = await readCancellationObservation(home, runId);
    if (cancellation.runRequested || cancellation.jobRequests.length > 0) {
      throw new CueLineError(
        "CONTROLLER_NOT_SENT_STATE_INVALID",
        "Not-sent recovery is forbidden while run or job cancellation is pending.",
      );
    }
    const events = await readAuthoritativeRunEvents(home, runId);
    const exactAmbiguousFailure =
      turn.submissionState !== "possibly_sent" ||
      state.lastFailure?.code !== "CONTROLLER_SUBMISSION_AMBIGUOUS" ||
      state.lastFailure.requestId !== turn.requestId
        ? false
        : true;
    const suppliedConversationUrl = options.conversationUrl;
    const knownConversationUrl = state.conversationUrl ?? turn.conversationUrl;
    const candidateConversationUrl = knownConversationUrl ?? suppliedConversationUrl;
    const evidenceGatedSubmittedTurn =
      options.browser !== undefined &&
      candidateConversationUrl !== undefined &&
      isSubmittedTurnRecoveryCandidate(turn, candidateConversationUrl);
    const legacyPreSubmissionFailure =
      options.browser !== undefined &&
      candidateConversationUrl !== undefined &&
      isLegacyPreSubmissionAdapterFailure(events, turn);
    if (
      !exactAmbiguousFailure &&
      !evidenceGatedSubmittedTurn &&
      !legacyPreSubmissionFailure
    ) {
      throw new CueLineError(
        "CONTROLLER_NOT_SENT_STATE_INVALID",
        "Not-sent recovery requires either the exact ambiguous submission failure or a fresh evidence-gated submitted turn.",
      );
    }
    if (turn.retryOfRequestId !== undefined && turn.retryOfRequestId !== null) {
      throw new CueLineError(
        "CONTROLLER_NOT_SENT_RETRY_EXHAUSTED",
        "The pending turn is already the one authorized not-sent retry; refusing another retry.",
      );
    }
    if (turn.manualSendConfirmed) {
      throw new CueLineError(
        "CONTROLLER_RECONCILIATION_CONFIRMATION_CONFLICT",
        "The turn is already operator-confirmed as sent; it cannot also be confirmed not sent.",
      );
    }
    if (knownConversationUrl === null && suppliedConversationUrl === undefined) {
      throw new CueLineError(
        "CONTROLLER_RECONCILIATION_URL_REQUIRED",
        "Operator-confirmed not-sent recovery requires the exact ChatGPT conversation URL.",
      );
    }
    if (
      suppliedConversationUrl !== undefined &&
      knownConversationUrl !== null &&
      !sameChatGptConversationUrl(suppliedConversationUrl, knownConversationUrl)
    ) {
      throw new CueLineError(
        "CONTROLLER_RECONCILIATION_CONVERSATION_MISMATCH",
        "The operator-confirmed URL does not match the run's exact ChatGPT conversation.",
      );
    }
    const conversationUrl = knownConversationUrl ?? suppliedConversationUrl!;
    if (!isExactChatGptConversationUrl(conversationUrl)) {
      throw new CueLineError(
        "CONTROLLER_RECONCILIATION_CONVERSATION_MISMATCH",
        "Operator-confirmed not-sent recovery requires an exact ChatGPT conversation URL.",
      );
    }
    if (
      !legacyPreSubmissionFailure &&
      (turn.selectedModelLabel === null || !/^Pro(?:\s|$)/i.test(turn.selectedModelLabel))
    ) {
      throw new CueLineError(
        "CONTROLLER_RECONCILIATION_MODEL_UNVERIFIED",
        "The pending turn lacks exact Pro composer model evidence.",
      );
    }
    if (!/^[0-9a-f]{64}$/.test(turn.promptHash)) {
      throw new CueLineError(
        "CONTROLLER_RECONCILIATION_PROMPT_HASH_INVALID",
        "The pending turn lacks a valid prompt hash.",
      );
    }
    for (const event of events) {
      const payload = eventPayload(event);
      if (
        event.type === "controller_response_received" &&
        payload.request_id === options.requestId
      ) {
        throw new CueLineError(
          "CONTROLLER_RECONCILIATION_SUPERSEDED",
          "A controller response for this request was already received; refusing not-sent recovery.",
        );
      }
      if (event.type !== "controller_command_accepted") continue;
      const command =
        typeof payload.command === "object" &&
        payload.command !== null &&
        !Array.isArray(payload.command)
          ? (payload.command as Record<string, unknown>)
          : {};
      if (
        command.request_id === options.requestId ||
        (typeof command.round === "number" && command.round >= turn.round)
      ) {
        throw new CueLineError(
          "CONTROLLER_RECONCILIATION_SUPERSEDED",
          "A command for this request or the same/newer controller round was already accepted.",
        );
      }
    }
    let submittedEvidence: BrowserSubmittedTurnEvidence | undefined;
    if (evidenceGatedSubmittedTurn || legacyPreSubmissionFailure) {
      const browser = options.browser!;
      if (browser.observeSubmittedTurn === undefined) {
        throw new CueLineError(
          "CONTROLLER_NOT_SENT_EVIDENCE_REQUIRED",
          "The normally submitted turn requires a fresh read-only Browser observation before it can be confirmed not sent.",
        );
      }
      const observation = await browser.observeSubmittedTurn({
        runId,
        round: turn.round,
        requestId: turn.requestId,
        prompt: turn.prompt,
        ...(typeof turn.baselineUserMessageCount === "number"
          ? { baselineUserMessageCount: turn.baselineUserMessageCount }
          : {}),
        ...(typeof turn.baselineAssistantMessageCount === "number"
          ? { baselineAssistantMessageCount: turn.baselineAssistantMessageCount }
          : {}),
        ...(turn.composerPromptState === "attachment_ready"
          ? { attachmentPromptExpected: true }
          : {}),
        ...(legacyPreSubmissionFailure
          ? { legacyPreSubmissionRecovery: true }
          : {}),
      });
      if (
        observation.status !== "definitely_not_sent" ||
        !(legacyPreSubmissionFailure
          ? isLegacyDefinitelyNotSentObservation(observation.evidence, conversationUrl)
          : isDefinitelyNotSentObservation(
              turn,
              conversationUrl,
              observation.evidence,
            ))
      ) {
        throw new CueLineError(
          "CONTROLLER_NOT_SENT_EVIDENCE_INSUFFICIENT",
          "The fresh conversation observation did not prove baseline-equal, request-absent, Pro-idle not-sent evidence.",
        );
      }
      submittedEvidence = observation.evidence;
    }
    const derivedBaselineUserMessageCount =
      turn.baselineUserMessageCount ??
      events.filter((event) => {
        if (event.type !== "controller_turn_submitted") return false;
        const payload =
          typeof event.payload === "object" &&
          event.payload !== null &&
          !Array.isArray(event.payload)
            ? (event.payload as Record<string, unknown>)
            : {};
        return typeof payload.round === "number" && payload.round < turn.round;
      }).length;
    const selectedModelLabel =
      submittedEvidence?.selectedModelLabel ?? turn.selectedModelLabel;
    if (selectedModelLabel === null) {
      throw new CueLineError(
        "CONTROLLER_RECONCILIATION_MODEL_UNVERIFIED",
        "Not-sent recovery lacks exact Pro composer model evidence.",
      );
    }
    const recoveryBaselineUserMessageCount =
      submittedEvidence?.baselineUserMessageCount ?? derivedBaselineUserMessageCount;
    if (existingRecovery === null) {
      await store.append("controller_turn_not_sent_confirmed", {
        round: turn.round,
        request_id: turn.requestId,
        prompt_hash: turn.promptHash,
        conversation_url: conversationUrl,
        selected_model_label: selectedModelLabel,
        baseline_user_message_count: recoveryBaselineUserMessageCount,
        ...(submittedEvidence === undefined
          ? { operator_confirmation: true }
          : {
              observed_user_message_count:
                submittedEvidence.observedUserMessageCount,
              request_message_found: false,
              is_answering: false,
              page_hydrated: true,
              submission_state: "definitely_not_sent",
              confirmation_source: legacyPreSubmissionFailure
                ? "legacy_pre_submission_adapter_failure"
                : "fresh_read_only_observation",
              operator_confirmation: !legacyPreSubmissionFailure,
            }),
      });
    }
    if (
      (store.state.pendingControllerTurns ?? []).some(
        (candidate) => candidate.requestId === turn.requestId,
      )
    ) {
      await store.append("controller_turn_abandoned", {
        round: turn.round,
        request_id: turn.requestId,
        reason: legacyPreSubmissionFailure
          ? "legacy_pre_submission_adapter_failure"
          : "operator_confirmed_not_sent",
        round_not_consumed: true,
        prompt_hash: turn.promptHash,
        conversation_url: conversationUrl,
        selected_model_label: selectedModelLabel,
        baseline_user_message_count: recoveryBaselineUserMessageCount,
        ...(submittedEvidence === undefined
          ? { operator_confirmation: true }
          : {
              observed_user_message_count:
                submittedEvidence.observedUserMessageCount,
              request_message_found: false,
              is_answering: false,
              page_hydrated: true,
              submission_state: "definitely_not_sent",
              confirmation_source: legacyPreSubmissionFailure
                ? "legacy_pre_submission_adapter_failure"
                : "fresh_read_only_observation",
              operator_confirmation: !legacyPreSubmissionFailure,
            }),
      });
    }
    await store.snapshot();
    return {
      runId,
      requestId: turn.requestId,
      conversationUrl,
      promptHash: turn.promptHash,
      outcome: existingRecovery === null ? "confirmed" : "already_confirmed",
    };
  } finally {
    await lease.release();
  }
}

function assertCallerJobResultInput(
  input: unknown,
): asserts input is CueLineCallerJobResultInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new CueLineError("CALLER_JOB_RESULT_INVALID", "Caller job result must be an object.");
  }
  const value = input as Record<string, unknown>;
  const terminalStatuses = new Set([
    "succeeded",
    "failed",
    "timed_out",
    "cancelled",
    "ambiguous",
  ]);
  if (typeof value.status !== "string" || !terminalStatuses.has(value.status)) {
    throw new CueLineError(
      "CALLER_JOB_STATUS_INVALID",
      `Unsupported caller job status '${String(value.status)}'.`,
    );
  }
  for (const field of [
    "stdout",
    "stderr",
    "output",
    "error",
    "startedAt",
    "finishedAt",
  ] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new CueLineError(
        "CALLER_JOB_RESULT_INVALID",
        `Caller job result field '${field}' must be a string when provided.`,
      );
    }
  }
  for (const field of ["startedAt", "finishedAt"] as const) {
    if (typeof value[field] === "string" && !Number.isFinite(Date.parse(value[field]))) {
      throw new CueLineError(
        "CALLER_JOB_RESULT_INVALID",
        `Caller job result field '${field}' must be a valid timestamp.`,
      );
    }
  }
  if (
    typeof value.startedAt === "string" &&
    typeof value.finishedAt === "string" &&
    Date.parse(value.finishedAt) < Date.parse(value.startedAt)
  ) {
    throw new CueLineError(
      "CALLER_JOB_RESULT_INVALID",
      "Caller job result finishedAt cannot precede startedAt.",
    );
  }
  if (
    value.exitCode !== undefined &&
    value.exitCode !== null &&
    !Number.isSafeInteger(value.exitCode)
  ) {
    throw new CueLineError(
      "CALLER_JOB_RESULT_INVALID",
      "Caller job result exitCode must be a safe integer or null when provided.",
    );
  }
}

function resolveCallerJobResultTimestamps(
  input: CueLineCallerJobResultInput,
  observedAt: Date,
): { startedAt: string; finishedAt: string } {
  let observedTimestamp: string;
  try {
    observedTimestamp = observedAt.toISOString();
  } catch (error) {
    throw new CueLineError(
      "CALLER_JOB_RESULT_INVALID",
      "Caller job result observation time must be a valid timestamp.",
      { cause: error },
    );
  }
  const startedAt = input.startedAt ?? observedTimestamp;
  const finishedAt = input.finishedAt ?? observedTimestamp;
  if (Date.parse(finishedAt) < Date.parse(startedAt)) {
    throw new CueLineError(
      "CALLER_JOB_RESULT_INVALID",
      "Caller job result finishedAt cannot precede startedAt.",
    );
  }
  return { startedAt, finishedAt };
}

function workResultIntentStatus(
  events: Awaited<ReturnType<typeof readAuthoritativeRunEvents>>,
  jobId: string,
  proof: CueLineCallerWorkClaimProof,
): string | undefined {
  for (const event of events) {
    if (event.type !== "caller_work_result_submission_started") continue;
    const payload =
      typeof event.payload === "object" &&
      event.payload !== null &&
      !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : {};
    if (
      payload.job_id === jobId &&
      payload.claim_id === proof.claimId &&
      payload.caller_id === proof.callerId &&
      payload.fencing_token === proof.fencingToken &&
      typeof payload.status === "string"
    ) {
      return payload.status;
    }
  }
  return undefined;
}

export async function submitCueLineCallerJobResult(
  runId: string,
  jobId: string,
  input: CueLineCallerJobResultInput,
  options: CueLineCallerJobSubmissionOptions = {},
): Promise<CueLineCallerJobSubmissionResult> {
  const environment = options.environment ?? runtimeEnvironment();
  const home = options.home ?? defaultCueLineHome(environment);
  const now = options.now ?? (() => new Date());
  assertCallerJobResultInput(input);
  await loadPersistedRunStore(home, runId);
  const runtime = await readRuntimeLease(home, runId, { now });
  const retiredOwner =
    (runtime.ownership === "active" || runtime.ownership === "stale") &&
    runtime.ownerId !== undefined &&
    (await retireDeadRuntimeLease(home, runId, runtime.ownerId))
      ? { ownerId: runtime.ownerId, ownership: runtime.ownership }
      : undefined;
  const lease = await RuntimeLease.claim({ home, runId, now });
  try {
    const store = await loadPersistedRunStore(home, runId);
    store.bindRuntimeOwner(lease.ownerId);
    if (retiredOwner !== undefined) {
      await store.append("runtime_dead_owner_retired", {
        owner_id: retiredOwner.ownerId,
        previous_ownership: retiredOwner.ownership,
      });
    }
    if (store.state.executor !== "caller") {
      throw new CueLineError(
        "CALLER_EXECUTOR_REQUIRED",
        `Run '${runId}' uses the process executor; caller results are not accepted.`,
      );
    }
    const job = store.state.jobs[jobId];
    if (!job) {
      throw new CueLineError("JOB_NOT_FOUND", `No job '${jobId}' exists in run '${runId}'.`);
    }
    const effectiveStatus =
      job.spec.mode === "work" && input.status !== "succeeded"
        ? "ambiguous"
        : input.status;
    const statusStore = new JobStatusStore(home);
    let terminal = await statusStore.read(jobId);
    if (terminal?.status === "pending" || terminal?.status === "running") {
      terminal = undefined;
    }
    if (terminal !== undefined) {
      if (terminal.runId !== runId || terminal.jobKey !== job.jobKey) {
        throw new CueLineError(
          "CALLER_JOB_RESULT_CONFLICT",
          `Persisted terminal evidence for '${jobId}' does not belong to this caller job.`,
        );
      }
    }
    const events = await readAuthoritativeRunEvents(home, runId);
    let resultObservedAt: Date | undefined;
    if (job.spec.mode === "work") {
      if (options.claim === undefined) {
        throw new CueLineError(
          "CALLER_WORK_CLAIM_REQUIRED",
          `Caller work result for '${jobId}' requires the exact active claim proof.`,
        );
      }
      const intentStatus = workResultIntentStatus(events, jobId, options.claim);
      const durableTerminalIntent =
        terminal !== undefined && intentStatus !== undefined && intentStatus === terminal.status;
      if (
        intentStatus !== undefined &&
        intentStatus !== (terminal?.status ?? effectiveStatus)
      ) {
        throw new CueLineError(
          "CALLER_JOB_RESULT_CONFLICT",
          `Caller work result intent for '${jobId}' is already bound to status '${intentStatus}'.`,
        );
      }
      resultObservedAt = now();
      const validation = await validateCallerWorkResultClaim(
        store,
        job,
        options.claim,
        home,
        resultObservedAt,
        { durableTerminalIntent },
      );
      if (validation.alreadyTerminal) {
        return { runId, jobId, outcome: "already_terminal" };
      }
    } else if (options.claim !== undefined) {
      throw new CueLineError(
        "CALLER_WORK_CLAIM_UNEXPECTED",
        `Advise job '${jobId}' does not accept a caller work claim.`,
      );
    } else if (job.status !== "pending" && job.status !== "running") {
      return { runId, jobId, outcome: "already_terminal" };
    }
    const resultTimestamps =
      terminal === undefined
        ? resolveCallerJobResultTimestamps(input, resultObservedAt ?? now())
        : undefined;
    if (job.spec.mode === "work" && options.claim !== undefined) {
      const intentStatus = workResultIntentStatus(events, jobId, options.claim);
      if (intentStatus === undefined) {
        await store.append("caller_work_result_submission_started", {
          job_id: jobId,
          status: terminal?.status ?? effectiveStatus,
          claim_id: options.claim.claimId,
          caller_id: options.claim.callerId,
          fencing_token: options.claim.fencingToken,
        });
      }
    }
    if (terminal === undefined) {
      const stdout = input.stdout ?? "";
      const stderr = input.stderr ?? "";
      const output =
        input.output ??
        (stdout === ""
          ? stderr
          : stderr === ""
            ? stdout
            : `${stdout}${stdout.endsWith("\n") ? "" : "\n"}${stderr}`);
      const { startedAt, finishedAt } = resultTimestamps!;
      const result = {
        status: effectiveStatus,
        exitCode: input.exitCode ?? (input.status === "succeeded" ? 0 : null),
        stdout,
        stderr,
        output,
        emptyOutput: output.length === 0,
        timedOut: input.status === "timed_out",
        cancelled: input.status === "cancelled",
        ambiguousSideEffects: job.spec.mode === "work" && input.status !== "succeeded",
        retryable: false as const,
        startedAt,
        finishedAt,
      };
      terminal = {
        jobId,
        runId,
        jobKey: job.jobKey,
        lane: job.spec.lane,
        mode: job.spec.mode,
        execution: "foreground",
        status: effectiveStatus,
        startedAt,
        finishedAt,
        result,
        ...(input.error === undefined ? {} : { error: input.error }),
      } satisfies JobStatus;
      await statusStore.write(terminal);
    }
    const alreadyRecorded = events.some((event) => {
      if (event.type !== "caller_job_result_submitted") return false;
      const payload =
        typeof event.payload === "object" &&
        event.payload !== null &&
        !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>)
          : {};
      return payload.job_id === jobId;
    });
    if (!alreadyRecorded) {
      await store.append("caller_job_result_submitted", {
        job_id: jobId,
        status: terminal.status,
      });
      if (job.spec.mode === "work" && options.claim !== undefined) {
        await store.append("caller_work_result_submitted", {
          job_id: jobId,
          status: terminal.status,
          claim_id: options.claim.claimId,
          caller_id: options.claim.callerId,
          fencing_token: options.claim.fencingToken,
        });
      }
    }
    await store.append("job_status", {
      job_id: jobId,
      status: terminal.status,
      ...boundedControllerEventEvidence(
        terminal,
        store.state.maxJobEvidenceChars,
      ),
    });
    await store.snapshot();
    return { runId, jobId, outcome: "submitted" };
  } finally {
    await lease.release();
  }
}
