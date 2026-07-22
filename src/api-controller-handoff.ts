import type {
  CueLineCallerJobSubmissionOptions,
  CueLineCallerJobResultInput,
  CueLineCallerJobSubmissionResult,
  CueLineCallerWorkClaimProof,
  ControllerMisdirectedConfirmation,
  ControllerNotSentConfirmation,
  ControllerPostFixRetryReauthorization,
  CueLineRuntimeOptions,
  ManualControllerSubmissionConfirmation,
} from "./api-contracts.js";
import type {
  BrowserMisdirectedTurnEvidence,
  BrowserSubmittedTurnEvidence,
} from "./browser/browser-adapter.js";
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
  hasRecoverableTurnIdentity,
  isDefinitelyNotSentObservation,
  isSubmissionStartedAttachmentRecoveryCandidate,
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
    (turn.submissionState !== "possibly_sent" && turn.submissionState !== "requested") ||
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
    failure.request_id !== turn.requestId ||
    failure.stage !== "controller_turn" ||
    failure.submission_state !== "requested"
  ) {
    return false;
  }
  // The legacy adapter shape (no sendTurn at all) recorded the turn as
  // possibly_sent and is only recognizable by its exact message. An internal
  // failure thrown at the submit entry before any checkpoint leaves the turn
  // "requested" with no submission events, which is itself the pre-submission
  // proof; the fresh read-only page observation below still gates recovery.
  if (
    turn.submissionState === "possibly_sent" &&
    failure.message !== "browser.sendTurn is not a function"
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

function lastAcceptedControllerIdentityBefore(
  events: AuthoritativeRunEvent[],
  round: number,
): { round: number; requestId: string } | null {
  let accepted: { round: number; requestId: string } | null = null;
  for (const event of events) {
    if (event.type !== "controller_command_accepted") continue;
    const payload = eventPayload(event);
    const command =
      typeof payload.command === "object" &&
      payload.command !== null &&
      !Array.isArray(payload.command)
        ? (payload.command as Record<string, unknown>)
        : {};
    if (typeof command.round !== "number" || command.round >= round) continue;
    if (typeof command.request_id !== "string") continue;
    if (accepted === null || command.round > accepted.round) {
      accepted = { round: command.round, requestId: command.request_id };
    }
  }
  return accepted;
}

function assertMisdirectedEvidence(
  evidence: BrowserMisdirectedTurnEvidence,
  expectedConversationUrl: string,
  misdirectedConversationUrl: string,
): void {
  if (
    !sameChatGptConversationUrl(
      evidence.misdirected.pageUrl,
      misdirectedConversationUrl,
    ) ||
    !sameChatGptConversationUrl(evidence.bound.pageUrl, expectedConversationUrl)
  ) {
    throw new CueLineError(
      "CONTROLLER_RECONCILIATION_CONVERSATION_MISMATCH",
      "Misdirected recovery evidence was read from an unexpected ChatGPT conversation.",
    );
  }
  if (!/^Pro(?:\s|$)/i.test(evidence.selectedModelLabel ?? "")) {
    throw new CueLineError(
      "CONTROLLER_RECONCILIATION_MODEL_UNVERIFIED",
      "Misdirected recovery requires exact Pro composer model evidence on the bound conversation.",
    );
  }
  if (
    !evidence.misdirected.exactEnvelopeFound ||
    evidence.bound.requestMessageFound ||
    evidence.bound.isAnswering ||
    !evidence.bound.priorEnvelopeFound
  ) {
    throw new CueLineError(
      "CONTROLLER_NOT_SENT_EVIDENCE_INSUFFICIENT",
      "Misdirected recovery requires exact orphan envelope evidence and a clean, idle bound conversation at the prior controller envelope.",
    );
  }
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
      (isSubmittedTurnRecoveryCandidate(turn, candidateConversationUrl) ||
        isSubmissionStartedAttachmentRecoveryCandidate(
          turn,
          candidateConversationUrl,
        ));
    const legacyPreSubmissionFailure =
      options.browser !== undefined &&
      candidateConversationUrl !== undefined &&
      isLegacyPreSubmissionAdapterFailure(events, turn);
    // Third legal entry: the submitter runtime died mid-submission and its stale lease was
    // formally taken over. The permanent record then proves: submission_started exists for
    // this exact request, controller_turn_submitted does NOT, and the takeover confirmation
    // was appended AFTER the submission started — so no live writer can still be mid-click.
    // In that provably-dead state the operator's --not-sent-confirmed is accepted without a
    // fresh browser observation (the identity gates — exact conversation URL, prompt hash,
    // Pro model, write-ahead contract, no retry, no manual-send conflict — still apply below).
    let submissionStartedSequence: number | undefined;
    let submittedEventForRequest = false;
    let takeoverConfirmedSequence: number | undefined;
    for (const event of events) {
      const payload = eventPayload(event);
      if (
        event.type === "controller_turn_submission_started" &&
        payload.request_id === options.requestId
      ) {
        submissionStartedSequence = event.sequence;
      } else if (
        event.type === "controller_turn_submitted" &&
        payload.request_id === options.requestId
      ) {
        submittedEventForRequest = true;
      } else if (event.type === "runtime_stale_owner_takeover_confirmed") {
        takeoverConfirmedSequence = event.sequence;
      }
    }
    const staleTakenOverSubmissionStart =
      turn.submissionState === "submitting" &&
      candidateConversationUrl !== undefined &&
      hasRecoverableTurnIdentity(turn, candidateConversationUrl) &&
      submissionStartedSequence !== undefined &&
      !submittedEventForRequest &&
      takeoverConfirmedSequence !== undefined &&
      takeoverConfirmedSequence > submissionStartedSequence;
    if (
      !exactAmbiguousFailure &&
      !evidenceGatedSubmittedTurn &&
      !legacyPreSubmissionFailure &&
      !staleTakenOverSubmissionStart
    ) {
      throw new CueLineError(
        "CONTROLLER_NOT_SENT_STATE_INVALID",
        "Not-sent recovery requires the exact ambiguous submission failure, a fresh evidence-gated submitted turn, or a taken-over stale runtime whose submission started but was never recorded as submitted.",
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
        ...(turn.composerPromptState === null
          ? {}
          : { composer_prompt_state: turn.composerPromptState }),
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
        ...(turn.composerPromptState === null
          ? {}
          : { composer_prompt_state: turn.composerPromptState }),
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

/**
 * Durable one-shot recovery after a permanently recorded send no-op. A fresh
 * read-only observation must prove the exact request absent. The next matching
 * controller_turn_requested consumes the grant; another grant requires a newer
 * CONTROLLER_PROMPT_NOT_SENT failure after that consumption.
 */
export async function reauthorizeControllerPostFixRetry(
  runId: string,
  options: Pick<CueLineRuntimeOptions, "home" | "environment" | "now" | "browser"> & {
    requestId: string;
    round: number;
    conversationUrl: string;
  },
): Promise<ControllerPostFixRetryReauthorization> {
  if (options.browser?.observeSubmittedTurn === undefined) {
    throw new CueLineError(
      "CONTROLLER_NOT_SENT_EVIDENCE_REQUIRED",
      "Post-fix retry reauthorization requires a fresh read-only browser observation.",
    );
  }
  const environment = options.environment ?? runtimeEnvironment();
  const home = options.home ?? defaultCueLineHome(environment);
  await loadPersistedRunStore(home, runId);
  const lease = await RuntimeLease.claim({
    home,
    runId,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  try {
    const store = await loadPersistedRunStore(home, runId);
    store.bindRuntimeOwner(lease.ownerId);
    const state = store.state;
    const existing = state.postFixRetryReauthorization;
    if (
      existing?.requestId === options.requestId &&
      existing.round === options.round &&
      existing.status === "authorized"
    ) {
      const authorizedRecovery = state.notSentRecovery;
      const authorizedStateMatches =
        typeof state.conversationUrl === "string" &&
        sameChatGptConversationUrl(state.conversationUrl, options.conversationUrl) &&
        authorizedRecovery?.abandonedRequestId === options.requestId &&
        authorizedRecovery.round === options.round &&
        authorizedRecovery.status === "confirmed" &&
        authorizedRecovery.retryRequestId === null &&
        sameChatGptConversationUrl(
          authorizedRecovery.conversationUrl,
          options.conversationUrl,
        );
      const cancellation = await readCancellationObservation(home, runId);
      if (
        !authorizedStateMatches ||
        cancellation.runRequested ||
        cancellation.jobRequests.length > 0
      ) {
        throw new CueLineError(
          "CONTROLLER_POST_FIX_RETRY_STATE_INVALID",
          "The existing one-shot authorization no longer matches the exact bound recovery state.",
        );
      }
      return {
        runId,
        requestId: options.requestId,
        conversationUrl: options.conversationUrl,
        promptHash: state.notSentRecovery?.promptHash ?? "",
        outcome: "already_reauthorized",
      };
    }
    if (
      existing?.requestId === options.requestId &&
      existing.round === options.round &&
      existing.status === "consumed"
    ) {
      const existingEvents = await readAuthoritativeRunEvents(home, runId);
      let latestAuthorizationIndex = -1;
      let latestNotSentFailureIndex = -1;
      for (const [index, event] of existingEvents.entries()) {
        const payload = eventPayload(event);
        if (
          event.type === "controller_turn_post_fix_retry_reauthorized" &&
          payload.request_id === options.requestId &&
          payload.round === options.round
        ) {
          latestAuthorizationIndex = index;
        }
        if (
          event.type === "run_failed" &&
          payload.request_id === options.requestId &&
          payload.code === "CONTROLLER_PROMPT_NOT_SENT" &&
          payload.submission_state === "definitely_not_sent"
        ) {
          latestNotSentFailureIndex = index;
        }
      }
      if (latestNotSentFailureIndex <= latestAuthorizationIndex) {
        throw new CueLineError(
          "CONTROLLER_POST_FIX_RETRY_EXHAUSTED",
          "The prior one-shot recovery was consumed and no newer permanently proven not-sent failure authorizes another grant.",
        );
      }
    }
    const pending = (state.pendingControllerTurns ?? []).find(
      (turn) => turn.requestId === options.requestId && turn.round === options.round,
    );
    const recovery = state.notSentRecovery;
    if (
      (state.pendingControllerTurns ?? []).length !== 1 ||
      pending === undefined ||
      pending.retryOfRequestId !== options.requestId ||
      pending.composerPromptState !== "attachment_ready" ||
      typeof pending.baselineUserMessageCount !== "number" ||
      pending.manualSendConfirmed ||
      state.lastFailure?.code !== "CONTROLLER_PROMPT_NOT_SENT" ||
      state.lastFailure.requestId !== options.requestId ||
      state.lastFailure.submissionState !== "definitely_not_sent" ||
      recovery?.status !== "retry_pending" ||
      recovery.retryRequestId !== options.requestId ||
      recovery.abandonedRequestId !== options.requestId ||
      recovery.round !== options.round ||
      recovery.composerPromptState !== "attachment_ready" ||
      typeof state.conversationUrl !== "string" ||
      !sameChatGptConversationUrl(state.conversationUrl, options.conversationUrl) ||
      typeof pending.conversationUrl !== "string" ||
      !sameChatGptConversationUrl(pending.conversationUrl, options.conversationUrl) ||
      !sameChatGptConversationUrl(recovery.conversationUrl, options.conversationUrl) ||
      (existing !== null &&
        existing !== undefined &&
        (existing.requestId !== options.requestId || existing.round !== options.round))
    ) {
      throw new CueLineError(
        "CONTROLLER_POST_FIX_RETRY_STATE_INVALID",
        "The persisted run does not exactly match a recoverable, permanently failed controller turn.",
      );
    }
    const cancellation = await readCancellationObservation(home, runId);
    if (cancellation.runRequested || cancellation.jobRequests.length > 0) {
      throw new CueLineError(
        "CONTROLLER_POST_FIX_RETRY_STATE_INVALID",
        "Post-fix retry reauthorization is forbidden while cancellation is pending.",
      );
    }
    const events = await readAuthoritativeRunEvents(home, runId);
    const findLastMatchingIndex = (
      predicate: (event: AuthoritativeRunEvent) => boolean,
      beforeExclusive = events.length,
    ): number => {
      for (let index = beforeExclusive - 1; index >= 0; index -= 1) {
        if (predicate(events[index]!)) return index;
      }
      return -1;
    };
    const matchesTurn = (event: AuthoritativeRunEvent): boolean => {
      const payload = eventPayload(event);
      return payload.request_id === options.requestId &&
        (payload.round === undefined || payload.round === options.round);
    };
    const lastAuthorizationIndex = findLastMatchingIndex(
      (event) =>
        event.type === "controller_turn_post_fix_retry_reauthorized" &&
        matchesTurn(event),
    );
    const lastRequestedIndex = findLastMatchingIndex(
      (event) => event.type === "controller_turn_requested" && matchesTurn(event),
    );
    const lastStartedIndex = findLastMatchingIndex(
      (event) => event.type === "controller_turn_submission_started" && matchesTurn(event),
    );
    const lastFailedIndex = findLastMatchingIndex((event) => {
      const payload = eventPayload(event);
      return event.type === "run_failed" &&
        payload.request_id === options.requestId &&
        payload.code === "CONTROLLER_PROMPT_NOT_SENT" &&
        payload.submission_state === "definitely_not_sent";
    });
    const hasSubmittedOrResponse = events.some((event) => {
      return (event.type === "controller_turn_submitted" ||
        event.type === "controller_response_received") &&
        matchesTurn(event);
    });
    const hasNewFailureCycle =
      lastRequestedIndex > lastAuthorizationIndex &&
      lastStartedIndex > lastRequestedIndex &&
      lastFailedIndex > lastStartedIndex;
    if (!hasNewFailureCycle || hasSubmittedOrResponse) {
      if (
        existing?.requestId === options.requestId &&
        existing.round === options.round &&
        existing.status === "consumed"
      ) {
        throw new CueLineError(
          "CONTROLLER_POST_FIX_RETRY_EXHAUSTED",
          "The prior one-shot recovery was consumed and no newer permanently proven not-sent failure authorizes another grant.",
        );
      }
      throw new CueLineError(
        "CONTROLLER_POST_FIX_RETRY_EVENT_MISMATCH",
        "Permanent events do not contain an unsubmitted request/start/not-sent failure cycle newer than the previous authorization.",
      );
    }
    const observation = await options.browser.observeSubmittedTurn({
      runId,
      round: pending.round,
      requestId: pending.requestId,
      prompt: pending.prompt,
      expectedConversationUrl: options.conversationUrl,
      ...(typeof pending.baselineUserMessageCount === "number"
        ? { baselineUserMessageCount: pending.baselineUserMessageCount }
        : {}),
      ...(typeof pending.baselineAssistantMessageCount === "number"
        ? { baselineAssistantMessageCount: pending.baselineAssistantMessageCount }
        : {}),
      attachmentPromptExpected: true,
      emptyComposerNotSentRecovery: true,
    });
    const evidence = observation.status === "definitely_not_sent"
      ? observation.evidence
      : undefined;
    const stagedAttachmentProven =
      evidence?.composerPromptState === "attachment_ready" &&
      evidence.composerAttachmentCount === 1 &&
      evidence.composerPastedTextAttachmentPresent === true &&
      evidence.composerSendButtonEnabled === true;
    const emptyComposerProven =
      evidence?.composerPromptState === "empty" &&
      evidence.composerAttachmentCount === 0 &&
      evidence.composerPastedTextAttachmentPresent !== true &&
      evidence.composerSendButtonEnabled === false;
    if (
      evidence === undefined ||
      !sameChatGptConversationUrl(evidence.conversationUrl, options.conversationUrl) ||
      evidence.selectedModelLabel === null ||
      !/^Pro(?:\s|$)/i.test(evidence.selectedModelLabel) ||
      evidence.hydrated !== true ||
      evidence.requestMessageFound !== false ||
      evidence.requestMessageScanComplete !== true ||
      evidence.accessibilityRequestIdFound !== false ||
      evidence.countRegressionDetected === true ||
      evidence.isAnswering !== false ||
      typeof evidence.observedUserMessageCount !== "number" ||
      evidence.observedUserMessageCount < pending.baselineUserMessageCount ||
      (!stagedAttachmentProven && !emptyComposerProven)
    ) {
      throw new CueLineError(
        "CONTROLLER_NOT_SENT_EVIDENCE_INSUFFICIENT",
        "Fresh evidence did not prove the exact idle Pro conversation, dual-source request absence, and either the exact staged attachment or an empty composer safe to restage.",
      );
    }
    const authorizationGeneration =
      events.filter(
        (event) =>
          event.type === "controller_turn_post_fix_retry_reauthorized" &&
          matchesTurn(event),
      ).length + 1;
    await store.append("controller_turn_post_fix_retry_reauthorized", {
      round: options.round,
      request_id: options.requestId,
      prompt_hash: pending.promptHash,
      conversation_url: options.conversationUrl,
      failure_code: "CONTROLLER_PROMPT_NOT_SENT",
      submission_state: "definitely_not_sent",
      not_sent_recovery_status: "retry_pending",
      composer_prompt_state: evidence.composerPromptState,
      composer_attachment_count: evidence.composerAttachmentCount,
      composer_attachment_kind: stagedAttachmentProven ? "pasted_text" : "none",
      restage_required: emptyComposerProven,
      baseline_user_message_count: pending.baselineUserMessageCount,
      observed_user_message_count: evidence.observedUserMessageCount,
      request_message_scan_complete: evidence.requestMessageScanComplete,
      accessibility_request_id_found: evidence.accessibilityRequestIdFound,
      count_regression_detected: evidence.countRegressionDetected ?? false,
      selected_model_label: evidence.selectedModelLabel,
      confirmation_source: "fresh_read_only_observation",
      authorization_generation: authorizationGeneration,
      one_shot: true,
    });
    await store.append("controller_turn_abandoned", {
      round: options.round,
      request_id: options.requestId,
      reason: "post_fix_retry_reauthorized",
      round_not_consumed: true,
    });
    await store.snapshot();
    return {
      runId,
      requestId: options.requestId,
      conversationUrl: options.conversationUrl,
      promptHash: pending.promptHash,
      outcome: "reauthorized",
    };
  } finally {
    await lease.release();
  }
}

export async function confirmControllerTurnMisdirected(
  runId: string,
  options: Pick<
    CueLineRuntimeOptions,
    "home" | "environment" | "now" | "browser"
  > & {
    requestId: string;
    misdirectedConversationUrl: string;
  },
): Promise<ControllerMisdirectedConfirmation> {
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
          misdirectedConversationUrl: options.misdirectedConversationUrl,
          promptHash: existingRecovery.promptHash,
          outcome: "already_confirmed",
          observedBaselineUserMessageCount: existingRecovery.baselineUserMessageCount,
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
        "Misdirected recovery requires exactly one pending controller turn.",
      );
    }
    const cancellation = await readCancellationObservation(home, runId);
    if (cancellation.runRequested || cancellation.jobRequests.length > 0) {
      throw new CueLineError(
        "CONTROLLER_NOT_SENT_STATE_INVALID",
        "Misdirected recovery is forbidden while run or job cancellation is pending.",
      );
    }
    if (turn.submissionState !== "submitted") {
      throw new CueLineError(
        "CONTROLLER_NOT_SENT_STATE_INVALID",
        "Misdirected recovery requires a submitted pending controller turn.",
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
        "The turn is already operator-confirmed as sent; it cannot also be recovered as misdirected.",
      );
    }
    if (turn.submissionCheckpointContract !== "write_ahead_v1") {
      throw new CueLineError(
        "CONTROLLER_NOT_SENT_STATE_INVALID",
        "Misdirected recovery requires the write-ahead submission checkpoint contract.",
      );
    }
    if (turn.selectedModelLabel === null || !/^Pro(?:\s|$)/i.test(turn.selectedModelLabel)) {
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
    if (
      state.lastFailure?.code !== "CONTROLLER_RECONCILIATION_CONVERSATION_MISMATCH" ||
      state.lastFailure.requestId !== turn.requestId
    ) {
      throw new CueLineError(
        "CONTROLLER_NOT_SENT_STATE_INVALID",
        "Misdirected recovery requires the exact conversation-mismatch failure for this request.",
      );
    }
    const conversationUrl = state.conversationUrl ?? turn.conversationUrl;
    if (conversationUrl === null || conversationUrl === undefined) {
      throw new CueLineError(
        "CONTROLLER_RECONCILIATION_URL_REQUIRED",
        "Misdirected recovery requires the exact bound ChatGPT conversation URL.",
      );
    }
    if (!isExactChatGptConversationUrl(conversationUrl)) {
      throw new CueLineError(
        "CONTROLLER_RECONCILIATION_CONVERSATION_MISMATCH",
        "Misdirected recovery requires an exact bound ChatGPT conversation URL.",
      );
    }
    if (!isExactChatGptConversationUrl(options.misdirectedConversationUrl)) {
      throw new CueLineError(
        "CONTROLLER_RECONCILIATION_CONVERSATION_MISMATCH",
        "Misdirected recovery requires an exact misdirected ChatGPT conversation URL.",
      );
    }
    if (
      sameChatGptConversationUrl(
        options.misdirectedConversationUrl,
        conversationUrl,
      )
    ) {
      throw new CueLineError(
        "CONTROLLER_RECONCILIATION_CONVERSATION_MISMATCH",
        "The misdirected conversation URL must differ from the bound CueLine conversation.",
      );
    }
    const events = await readAuthoritativeRunEvents(home, runId);
    for (const event of events) {
      const payload = eventPayload(event);
      if (
        event.type === "controller_response_received" &&
        payload.request_id === options.requestId
      ) {
        throw new CueLineError(
          "CONTROLLER_RECONCILIATION_SUPERSEDED",
          "A controller response for this request was already received; refusing misdirected recovery.",
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
    const prior = lastAcceptedControllerIdentityBefore(events, turn.round);
    if (prior === null) {
      throw new CueLineError(
        "CONTROLLER_NOT_SENT_EVIDENCE_REQUIRED",
        "Misdirected recovery requires an accepted prior controller envelope to validate the bound conversation.",
      );
    }
    const browser = options.browser;
    if (browser?.observeMisdirectedTurn === undefined) {
      throw new CueLineError(
        "CONTROLLER_NOT_SENT_EVIDENCE_REQUIRED",
        "Misdirected recovery requires a fresh read-only Browser observation.",
      );
    }
    const observation = await browser.observeMisdirectedTurn({
      runId,
      round: turn.round,
      requestId: turn.requestId,
      prompt: turn.prompt,
      expectedConversationUrl: conversationUrl,
      misdirectedConversationUrl: options.misdirectedConversationUrl,
      expectedPriorRound: prior.round,
      expectedPriorRequestId: prior.requestId,
    });
    if (observation.status === "pending") {
      return {
        runId,
        requestId: turn.requestId,
        conversationUrl,
        misdirectedConversationUrl: options.misdirectedConversationUrl,
        promptHash: turn.promptHash,
        outcome: "pending",
        observedBaselineUserMessageCount: observation.evidence.bound.userMessageCount,
        evidence: observation.evidence,
      };
    }
    assertMisdirectedEvidence(
      observation.evidence,
      conversationUrl,
      options.misdirectedConversationUrl,
    );
    const selectedModelLabel = observation.evidence.selectedModelLabel;
    const recoveryBaselineUserMessageCount =
      observation.evidence.bound.userMessageCount ?? turn.baselineUserMessageCount ?? 0;
    await store.append("controller_turn_misdirected_confirmed", {
      round: turn.round,
      request_id: turn.requestId,
      prompt_hash: turn.promptHash,
      bound_conversation_url: conversationUrl,
      misdirected_conversation_url: options.misdirectedConversationUrl,
      selected_model_label: selectedModelLabel,
      prior_round: prior.round,
      prior_request_id: prior.requestId,
      orphan_evidence: {
        exact_envelope_found: observation.evidence.misdirected.exactEnvelopeFound,
        is_answering: observation.evidence.misdirected.isAnswering,
        assistant_message_count:
          observation.evidence.misdirected.assistantMessageCount,
      },
      bound_evidence: {
        request_message_found: observation.evidence.bound.requestMessageFound,
        is_answering: observation.evidence.bound.isAnswering,
        prior_envelope_found: observation.evidence.bound.priorEnvelopeFound,
        observed_user_message_count:
          observation.evidence.bound.userMessageCount,
        assistant_message_count:
          observation.evidence.bound.assistantMessageCount,
      },
    });
    await store.append("controller_turn_not_sent_confirmed", {
      round: turn.round,
      request_id: turn.requestId,
      prompt_hash: turn.promptHash,
      conversation_url: conversationUrl,
      selected_model_label: selectedModelLabel,
      baseline_user_message_count: recoveryBaselineUserMessageCount,
      ...(turn.composerPromptState === null
        ? {}
        : { composer_prompt_state: turn.composerPromptState }),
      observed_user_message_count: recoveryBaselineUserMessageCount,
      request_message_found: false,
      is_answering: false,
      page_hydrated: true,
      submission_state: "definitely_not_sent",
      confirmation_source: "misdirected_read_only_observation",
      operator_confirmation: false,
    });
    if (
      (store.state.pendingControllerTurns ?? []).some(
        (candidate) => candidate.requestId === turn.requestId,
      )
    ) {
      await store.append("controller_turn_abandoned", {
        round: turn.round,
        request_id: turn.requestId,
        reason: "misdirected_submission_confirmed",
        round_not_consumed: true,
        prompt_hash: turn.promptHash,
        conversation_url: conversationUrl,
        selected_model_label: selectedModelLabel,
        baseline_user_message_count: recoveryBaselineUserMessageCount,
        ...(turn.composerPromptState === null
          ? {}
          : { composer_prompt_state: turn.composerPromptState }),
        observed_user_message_count: recoveryBaselineUserMessageCount,
        request_message_found: false,
        is_answering: false,
        page_hydrated: true,
        submission_state: "definitely_not_sent",
        confirmation_source: "misdirected_read_only_observation",
        operator_confirmation: false,
      });
    }
    await store.snapshot();
    return {
      runId,
      requestId: turn.requestId,
      conversationUrl,
      misdirectedConversationUrl: options.misdirectedConversationUrl,
      promptHash: turn.promptHash,
      outcome: "confirmed",
      observedBaselineUserMessageCount: recoveryBaselineUserMessageCount,
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
