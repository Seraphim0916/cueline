import path from "node:path";

import type {
  ControllerCommand,
  ControllerJobSpec,
  JobObservation,
} from "../protocol/types.js";
import type { RunEvent } from "../state/event-log.js";
import {
  isExactChatGptConversationUrl,
  sameChatGptConversationUrl,
} from "./conversation-url.js";
import { jobSpecHash } from "./ids.js";

export type CueLineRunStatus = "running" | "complete" | "blocked" | "cancelled" | "failed";
export type CueLineExecutor = "caller" | "process";
export const DEFAULT_MAX_ROUNDS = 12;
export type StoredJobStatus = JobObservation["status"];
const STORED_JOB_STATUSES = new Set<StoredJobStatus>([
  "pending",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "ambiguous",
]);
const TERMINAL_JOB_STATUSES = new Set<StoredJobStatus>([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "ambiguous",
]);
export type ControllerSubmissionState =
  | "requested"
  | "submitting"
  | "possibly_sent"
  | "submitted";

export type ControllerConversationArchiveStatus =
  | "disabled"
  | "waiting_for_completion"
  | "pending"
  | "started"
  | "archived"
  | "ambiguous"
  | "failed";

export interface ControllerConversationArchiveState {
  enabled: boolean;
  status: ControllerConversationArchiveStatus;
  code: string | null;
  message: string | null;
  proof: "conversation_url_changed" | null;
  postActionUrl: string | null;
}

export interface PendingControllerTurn {
  round: number;
  requestId: string;
  prompt: string;
  promptHash: string;
  repairAttempt: number;
  submissionState: ControllerSubmissionState;
  conversationUrl: string | null;
  selectedModelLabel: string | null;
  baselineUserMessageCount?: number | null | undefined;
  baselineAssistantMessageCount: number | null;
  baselineLastUserMessageHash?: string | null | undefined;
  composerPromptState: "inline_ready" | "attachment_ready" | null;
  manualSendConfirmed: boolean;
  retryOfRequestId?: string | null | undefined;
  submissionCheckpointContract?: "write_ahead_v1" | null;
}

export interface ControllerNotSentRecoveryState {
  abandonedRequestId: string;
  round: number;
  promptHash: string;
  conversationUrl: string;
  baselineUserMessageCount: number | null;
  selectedModelLabel: string;
  status: "confirmed" | "retry_pending" | "conflict";
  retryRequestId: string | null;
  conflictCode: string | null;
}

export interface RunFailureEvidence {
  code: string;
  requestId: string | null;
  message: string | null;
  stage: string | null;
  submissionState: "definitely_not_sent" | ControllerSubmissionState | null;
  conversationUrl: string | null;
}

export interface CallerWorkClaim {
  claimId: string;
  callerId: string;
  taskHash: string;
  workdir: string;
  workdirIdentity?: CallerWorkdirIdentity;
  fencingToken: number;
  claimedAt: string;
  heartbeatAt: string;
  expiresAt: string;
  ttlMs: number;
  startedAt: string | null;
}

export interface CallerWorkdirIdentity {
  resolvedPath: string;
  device: string;
  inode: string;
}

export interface CallerWorkState {
  claim: CallerWorkClaim | null;
  nextFencingToken: number;
}

export interface StoredJob {
  jobId: string;
  jobKey: string;
  required: boolean;
  spec: ControllerJobSpec;
  status: StoredJobStatus;
  output: string | null;
  error: string | null;
  callerWork?: CallerWorkState;
  runtime?: {
    runnerId?: string;
    pid?: number;
    model?: string;
    provider?: string;
    phase?: string;
    lastProgressAt?: string;
  };
}

export interface PendingCommandExecution {
  command: ControllerCommand;
  commandHash: string;
}

export interface CueLineRunState {
  runId: string;
  request: string;
  executor: CueLineExecutor;
  allowProcessExecution: boolean;
  maxRounds: number;
  status: CueLineRunStatus;
  round: number;
  conversationUrl: string | null;
  controllerConversationArchive: ControllerConversationArchiveState;
  pendingControllerTurns: PendingControllerTurn[];
  abandonedControllerTurns: PendingControllerTurn[];
  notSentRecovery?: ControllerNotSentRecoveryState | null | undefined;
  lastFailure: RunFailureEvidence | null;
  jobs: Record<string, StoredJob>;
  /** Job IDs explicitly requested by the most recently accepted inspect command. */
  inspectionJobIds: string[];
  /** Raw-character evidence offset for an inspect command targeting exactly one job. */
  inspectionEvidenceOffset?: number;
  /** Content identity that fences a paginated inspect against output replacement. */
  inspectionEvidenceHash?: string | null;
  notices: string[];
  commandHashes: string[];
  pendingCommandExecution: PendingCommandExecution | null;
  finalDeliveryText: string | null;
  blockedReason: string | null;
  cancelledReason: string | null;
}

function validCallerId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validWorkdirIdentity(value: unknown): value is CallerWorkdirIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.resolvedPath === "string" &&
    path.isAbsolute(record.resolvedPath) &&
    typeof record.device === "string" &&
    /^\d+$/.test(record.device) &&
    typeof record.inode === "string" &&
    /^\d+$/.test(record.inode)
  );
}

function sameWorkdirIdentity(value: unknown, expected: CallerWorkdirIdentity): boolean {
  return (
    validWorkdirIdentity(value) &&
    value.resolvedPath === expected.resolvedPath &&
    value.device === expected.device &&
    value.inode === expected.inode
  );
}

function validClaimWindow(
  heartbeatAt: unknown,
  expiresAt: unknown,
  ttlMs: unknown,
): boolean {
  if (
    !validIsoTimestamp(heartbeatAt) ||
    !validIsoTimestamp(expiresAt) ||
    !Number.isSafeInteger(ttlMs) ||
    (ttlMs as number) < 1_000 ||
    (ttlMs as number) > 86_400_000
  ) {
    return false;
  }
  return Date.parse(expiresAt) - Date.parse(heartbeatAt) === ttlMs;
}

function recordPayload(event: RunEvent): Record<string, unknown> {
  if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
    return {};
  }
  return event.payload as Record<string, unknown>;
}

function preserveCanonicalConversationUrl(
  canonical: string | null,
  candidate: unknown,
): string | null {
  if (!isExactChatGptConversationUrl(candidate)) return canonical;
  if (
    canonical !== null &&
    !sameChatGptConversationUrl(candidate, canonical)
  ) {
    return canonical;
  }
  return canonical ?? candidate;
}

function initialControllerConversationArchive(
  enabled: boolean,
): ControllerConversationArchiveState {
  return {
    enabled,
    status: enabled ? "waiting_for_completion" : "disabled",
    code: null,
    message: null,
    proof: null,
    postActionUrl: null,
  };
}

function controllerConversationArchive(
  state: CueLineRunState,
): ControllerConversationArchiveState {
  return state.controllerConversationArchive ?? initialControllerConversationArchive(false);
}

export function initialRunState(
  runId: string,
  request: string,
  executor: CueLineExecutor = "caller",
  maxRounds = DEFAULT_MAX_ROUNDS,
  allowProcessExecution = false,
  archiveControllerConversationOnComplete = false,
): CueLineRunState {
  return {
    runId,
    request,
    executor,
    allowProcessExecution,
    maxRounds,
    status: "running",
    round: 0,
    conversationUrl: null,
    controllerConversationArchive: initialControllerConversationArchive(
      archiveControllerConversationOnComplete,
    ),
    pendingControllerTurns: [],
    abandonedControllerTurns: [],
    notSentRecovery: null,
    lastFailure: null,
    jobs: {},
    inspectionJobIds: [],
    inspectionEvidenceOffset: 0,
    inspectionEvidenceHash: null,
    notices: [],
    commandHashes: [],
    pendingCommandExecution: null,
    finalDeliveryText: null,
    blockedReason: null,
    cancelledReason: null,
  };
}

export function isControllerTurnProvenUnsent(
  state: CueLineRunState,
  turn: PendingControllerTurn | undefined,
): boolean {
  if (turn?.submissionState !== "requested") return false;
  if (turn.submissionCheckpointContract === "write_ahead_v1") return true;
  return (
    state.lastFailure?.requestId === turn.requestId &&
    state.lastFailure.submissionState === "definitely_not_sent"
  );
}

export function reduceRunState(state: CueLineRunState, event: RunEvent): CueLineRunState {
  const payload = recordPayload(event);
  if (event.type === "run_created" && typeof payload.request === "string") {
    const archiveEnabled = payload.archive_controller_conversation_on_complete === true;
    return {
      ...state,
      request: payload.request,
      executor:
        payload.executor === "caller" || payload.executor === "process"
          ? payload.executor
          : state.executor ?? "caller",
      allowProcessExecution:
        payload.allow_process_execution === true || state.allowProcessExecution === true,
      maxRounds:
        typeof payload.max_rounds === "number" &&
        Number.isSafeInteger(payload.max_rounds) &&
        payload.max_rounds >= 1
          ? payload.max_rounds
          : state.maxRounds ?? DEFAULT_MAX_ROUNDS,
      controllerConversationArchive: initialControllerConversationArchive(archiveEnabled),
    };
  }
  if (event.type === "run_resumed") {
    return { ...state, status: "running" };
  }
  if (
    (event.type === "controller_turn_requested" || event.type === "controller_repair_requested") &&
    typeof payload.round === "number" &&
    typeof payload.request_id === "string" &&
    typeof payload.prompt === "string" &&
    typeof payload.prompt_hash === "string"
  ) {
    return {
      ...state,
      round: payload.round,
      pendingControllerTurns: [
        ...(state.pendingControllerTurns ?? []).filter(
          (turn) => turn.requestId !== payload.request_id,
        ),
        {
          round: payload.round,
          requestId: payload.request_id,
          prompt: payload.prompt,
          promptHash: payload.prompt_hash,
          repairAttempt:
            typeof payload.repair_attempt === "number" ? payload.repair_attempt : 0,
          submissionState: "requested",
          conversationUrl: state.conversationUrl,
          selectedModelLabel: null,
          baselineUserMessageCount: null,
          baselineAssistantMessageCount: null,
          baselineLastUserMessageHash: null,
          composerPromptState: null,
          manualSendConfirmed: false,
          retryOfRequestId:
            typeof payload.retry_of_request_id === "string"
              ? payload.retry_of_request_id
              : null,
          submissionCheckpointContract:
            payload.submission_checkpoint_contract === "write_ahead_v1"
              ? "write_ahead_v1"
              : null,
        },
      ],
      abandonedControllerTurns: (state.abandonedControllerTurns ?? []).filter(
        (turn) => turn.requestId !== payload.request_id,
      ),
      notSentRecovery:
        typeof payload.retry_of_request_id === "string" &&
        state.notSentRecovery?.abandonedRequestId === payload.retry_of_request_id
          ? {
              ...state.notSentRecovery,
              status: "retry_pending",
              retryRequestId: payload.request_id,
              conflictCode: null,
            }
          : state.notSentRecovery ?? null,
    };
  }
  if (
    event.type === "controller_conversation_bound" &&
    typeof payload.conversation_url === "string" &&
    payload.conversation_url !== ""
  ) {
    const boundTurn =
      typeof payload.request_id === "string"
        ? (state.pendingControllerTurns ?? []).find(
            (turn) => turn.requestId === payload.request_id,
          )
        : undefined;
    const conversationUrl = preserveCanonicalConversationUrl(
      state.conversationUrl ?? boundTurn?.conversationUrl ?? null,
      payload.conversation_url,
    );
    return {
      ...state,
      conversationUrl,
      pendingControllerTurns: (state.pendingControllerTurns ?? []).map((turn) =>
        typeof payload.request_id === "string" && turn.requestId === payload.request_id
          ? {
              ...turn,
              conversationUrl: preserveCanonicalConversationUrl(
                turn.conversationUrl ?? state.conversationUrl,
                payload.conversation_url,
              ),
            }
          : turn,
      ),
    };
  }
  if (
    (event.type === "controller_turn_submission_started" ||
      event.type === "controller_turn_submitted") &&
    typeof payload.request_id === "string"
  ) {
    const pending = (state.pendingControllerTurns ?? []).find(
      (turn) => turn.requestId === payload.request_id,
    );
    if (!pending) return state;
    const conversationUrl = preserveCanonicalConversationUrl(
      state.conversationUrl ?? pending.conversationUrl,
      payload.conversation_url,
    );
    return {
      ...state,
      conversationUrl: conversationUrl ?? state.conversationUrl,
      pendingControllerTurns: (state.pendingControllerTurns ?? []).map((turn) =>
        turn.requestId !== payload.request_id
          ? turn
          : {
              ...turn,
              submissionState:
                payload.submission_state === "submitted"
                  ? "submitted"
                  : payload.submission_state === "possibly_sent"
                    ? "possibly_sent"
                    : "submitting",
              conversationUrl,
              selectedModelLabel:
                typeof payload.selected_model_label === "string"
                  ? payload.selected_model_label
                  : turn.selectedModelLabel,
              baselineUserMessageCount:
                typeof payload.baseline_user_message_count === "number"
                  ? payload.baseline_user_message_count
                  : turn.baselineUserMessageCount,
              baselineAssistantMessageCount:
                typeof payload.baseline_assistant_message_count === "number"
                  ? payload.baseline_assistant_message_count
                  : turn.baselineAssistantMessageCount,
              baselineLastUserMessageHash:
                typeof payload.baseline_last_user_message_hash === "string"
                  ? payload.baseline_last_user_message_hash
                  : turn.baselineLastUserMessageHash,
              composerPromptState:
                payload.composer_prompt_state === "inline_ready" ||
                payload.composer_prompt_state === "attachment_ready"
                  ? payload.composer_prompt_state
                  : turn.composerPromptState,
            },
      ),
    };
  }
  if (event.type === "controller_response_received") {
    return {
      ...state,
      conversationUrl: preserveCanonicalConversationUrl(
        state.conversationUrl,
        payload.conversation_url,
      ),
      // A received response is not yet an accepted command. Keep the exact
      // pending turn recoverable until controller_command_accepted commits;
      // otherwise a crash between these two events can resend the next round.
      pendingControllerTurns: state.pendingControllerTurns ?? [],
      lastFailure: null,
    };
  }
  if (event.type === "controller_turn_abandoned" && typeof payload.request_id === "string") {
    const abandoned = (state.pendingControllerTurns ?? []).find(
      (turn) => turn.requestId === payload.request_id,
    );
    const roundWasNotConsumed =
      payload.round_not_consumed === true &&
      abandoned !== undefined &&
      abandoned.round === state.round;
    return {
      ...state,
      round: roundWasNotConsumed ? Math.max(0, state.round - 1) : state.round,
      pendingControllerTurns: (state.pendingControllerTurns ?? []).filter(
        (turn) => turn.requestId !== payload.request_id,
      ),
      abandonedControllerTurns:
        abandoned === undefined
          ? state.abandonedControllerTurns ?? []
          : [
              ...(state.abandonedControllerTurns ?? []).filter(
                (turn) => turn.requestId !== abandoned.requestId,
              ),
              abandoned,
            ],
      notSentRecovery:
        abandoned?.retryOfRequestId !== undefined &&
        abandoned.retryOfRequestId !== null &&
        payload.reason === "definitely_not_sent_retry" &&
        state.notSentRecovery?.abandonedRequestId === abandoned.retryOfRequestId
          ? {
              ...state.notSentRecovery,
              status: "confirmed",
              retryRequestId: null,
              conflictCode: null,
            }
          : payload.reason === "operator_confirmed_not_sent" &&
        abandoned !== undefined &&
        typeof payload.prompt_hash === "string" &&
        typeof payload.conversation_url === "string" &&
        typeof payload.selected_model_label === "string"
          ? {
              abandonedRequestId: abandoned.requestId,
              round: abandoned.round,
              promptHash: payload.prompt_hash,
              conversationUrl: payload.conversation_url,
              baselineUserMessageCount:
                typeof payload.baseline_user_message_count === "number"
                  ? payload.baseline_user_message_count
                  : null,
              selectedModelLabel: payload.selected_model_label,
              status: "confirmed",
              retryRequestId: null,
              conflictCode: null,
            }
          : state.notSentRecovery ?? null,
    };
  }
  if (
    event.type === "controller_turn_not_sent_confirmed" &&
    typeof payload.request_id === "string" &&
    typeof payload.round === "number" &&
    typeof payload.prompt_hash === "string" &&
    typeof payload.conversation_url === "string" &&
    typeof payload.selected_model_label === "string"
  ) {
    return {
      ...state,
      notSentRecovery: {
        abandonedRequestId: payload.request_id,
        round: payload.round,
        promptHash: payload.prompt_hash,
        conversationUrl: payload.conversation_url,
        baselineUserMessageCount:
          typeof payload.baseline_user_message_count === "number"
            ? payload.baseline_user_message_count
            : null,
        selectedModelLabel: payload.selected_model_label,
        status: "confirmed",
        retryRequestId: null,
        conflictCode: null,
      },
    };
  }
  if (
    event.type === "controller_turn_retry_conflict" &&
    typeof payload.code === "string"
  ) {
    return {
      ...state,
      status: "failed",
      notSentRecovery:
        state.notSentRecovery === undefined || state.notSentRecovery === null
          ? state.notSentRecovery
          : {
              ...state.notSentRecovery,
              status: "conflict",
              conflictCode: payload.code,
            },
      lastFailure: {
        code: payload.code,
        requestId:
          typeof payload.request_id === "string" ? payload.request_id : null,
        message: typeof payload.message === "string" ? payload.message : null,
        stage: "not_sent_recovery",
        submissionState: null,
        conversationUrl: state.conversationUrl,
      },
    };
  }
  if (
    event.type === "controller_turn_manual_submission_confirmed" &&
    typeof payload.request_id === "string"
  ) {
    const existing =
      (state.pendingControllerTurns ?? []).find(
        (turn) => turn.requestId === payload.request_id,
      ) ??
      (state.abandonedControllerTurns ?? []).find(
        (turn) => turn.requestId === payload.request_id,
      );
    if (!existing) return state;
    const restored: PendingControllerTurn = {
      ...existing,
      submissionState: "submitted",
      manualSendConfirmed: true,
      conversationUrl: preserveCanonicalConversationUrl(
        state.conversationUrl ?? existing.conversationUrl,
        payload.conversation_url,
      ),
    };
    return {
      ...state,
      conversationUrl: restored.conversationUrl ?? state.conversationUrl,
      pendingControllerTurns: [
        ...(state.pendingControllerTurns ?? []).filter(
          (turn) => turn.requestId !== restored.requestId,
        ),
        restored,
      ],
      abandonedControllerTurns: (state.abandonedControllerTurns ?? []).filter(
        (turn) => turn.requestId !== restored.requestId,
      ),
    };
  }
  if (event.type === "controller_command_accepted" && typeof payload.command_hash === "string") {
    const command =
      typeof payload.command === "object" &&
      payload.command !== null &&
      !Array.isArray(payload.command)
        ? (payload.command as Record<string, unknown>)
        : {};
    const requestId =
      typeof command.request_id === "string" ? command.request_id : undefined;
    const inspectionJobIds =
      command.action === "inspect"
        ? Array.isArray(command.job_ids)
          ? command.job_ids.filter((value): value is string => typeof value === "string")
          : Object.keys(state.jobs)
        : [];
    const inspectionEvidenceOffset =
      command.action === "inspect" &&
      Number.isSafeInteger(command.evidence_offset) &&
      (command.evidence_offset as number) >= 0
        ? (command.evidence_offset as number)
        : 0;
    const inspectionEvidenceHash =
      command.action === "inspect" &&
      typeof command.evidence_hash === "string" &&
      /^[0-9a-f]{64}$/.test(command.evidence_hash)
        ? command.evidence_hash
        : null;
    return {
      ...state,
      inspectionJobIds,
      inspectionEvidenceOffset,
      inspectionEvidenceHash,
      commandHashes: [...state.commandHashes, payload.command_hash],
      pendingCommandExecution:
        typeof payload.command === "object" &&
        payload.command !== null &&
        !Array.isArray(payload.command)
          ? {
              command: structuredClone(payload.command) as ControllerCommand,
              commandHash: payload.command_hash,
            }
          : state.pendingCommandExecution ?? null,
      pendingControllerTurns:
        requestId === undefined
          ? state.pendingControllerTurns ?? []
          : (state.pendingControllerTurns ?? []).filter(
              (turn) => turn.requestId !== requestId,
            ),
    };
  }
  if (
    event.type === "controller_command_execution_completed" &&
    typeof payload.command_hash === "string"
  ) {
    return {
      ...state,
      pendingCommandExecution:
        state.pendingCommandExecution?.commandHash === payload.command_hash
          ? null
          : state.pendingCommandExecution ?? null,
    };
  }
  if (event.type === "notice" && typeof payload.message === "string") {
    return { ...state, notices: [...state.notices, payload.message] };
  }
  if (event.type === "job_registered") {
    const job = payload.job as StoredJob | undefined;
    if (!job) return state;
    return { ...state, jobs: { ...state.jobs, [job.jobId]: structuredClone(job) } };
  }
  if (event.type === "caller_work_claimed") {
    const existing = typeof payload.job_id === "string" ? state.jobs[payload.job_id] : undefined;
    const claim = payload.claim;
    if (
      state.executor !== "caller" ||
      !existing ||
      existing.spec.mode !== "work" ||
      existing.status !== "pending" ||
      existing.callerWork?.claim != null ||
      typeof claim !== "object" ||
      claim === null ||
      Array.isArray(claim)
    ) {
      return state;
    }
    const record = claim as Record<string, unknown>;
    if (
      typeof record.claimId !== "string" ||
      !/^claim_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        record.claimId,
      ) ||
      !validCallerId(record.callerId) ||
      typeof record.taskHash !== "string" ||
      record.taskHash !== jobSpecHash(existing.spec) ||
      typeof record.workdir !== "string" ||
      record.workdir !== existing.spec.workdir ||
      (record.workdirIdentity !== undefined &&
        !validWorkdirIdentity(record.workdirIdentity)) ||
      !Number.isSafeInteger(record.fencingToken) ||
      record.fencingToken !== (existing.callerWork?.nextFencingToken ?? 0) + 1 ||
      !validIsoTimestamp(record.claimedAt) ||
      record.heartbeatAt !== record.claimedAt ||
      !validClaimWindow(record.heartbeatAt, record.expiresAt, record.ttlMs) ||
      record.startedAt !== null
    ) {
      return state;
    }
    const acceptedClaim = structuredClone(claim) as CallerWorkClaim;
    return {
      ...state,
      jobs: {
        ...state.jobs,
        [existing.jobId]: {
          ...existing,
          callerWork: {
            claim: acceptedClaim,
            nextFencingToken: acceptedClaim.fencingToken,
          },
        },
      },
    };
  }
  if (
    (event.type === "caller_work_started" || event.type === "caller_work_heartbeat") &&
    typeof payload.job_id === "string" &&
    typeof payload.claim_id === "string" &&
    Number.isSafeInteger(payload.fencing_token)
  ) {
    const existing = state.jobs[payload.job_id];
    const claim = existing?.callerWork?.claim;
    if (
      !existing ||
      !claim ||
      (event.type === "caller_work_started"
        ? existing.status !== "pending" || claim.startedAt !== null
        : (existing.status !== "pending" && existing.status !== "running")) ||
      claim.claimId !== payload.claim_id ||
      claim.fencingToken !== payload.fencing_token ||
      payload.caller_id !== claim.callerId ||
      (event.type === "caller_work_started" &&
        (payload.task_hash !== claim.taskHash ||
          payload.workdir !== claim.workdir ||
          (claim.workdirIdentity !== undefined &&
            !sameWorkdirIdentity(payload.workdir_identity, claim.workdirIdentity))))
    ) {
      return state;
    }
    const timestamp =
      event.type === "caller_work_started"
        ? payload.started_at
        : payload.heartbeat_at;
    const expiresAt = payload.expires_at;
    if (
      !validIsoTimestamp(timestamp) ||
      !validIsoTimestamp(expiresAt) ||
      !validClaimWindow(timestamp, expiresAt, claim.ttlMs) ||
      Date.parse(timestamp) < Date.parse(claim.heartbeatAt)
    ) {
      return state;
    }
    const updatedClaim: CallerWorkClaim = {
      ...claim,
      heartbeatAt: timestamp,
      expiresAt,
      ...(event.type === "caller_work_started" ? { startedAt: timestamp } : {}),
    };
    return {
      ...state,
      jobs: {
        ...state.jobs,
        [existing.jobId]: {
          ...existing,
          status: event.type === "caller_work_started" ? "running" : existing.status,
          callerWork: {
            claim: updatedClaim,
            nextFencingToken: existing.callerWork?.nextFencingToken ?? claim.fencingToken,
          },
        },
      },
    };
  }
  if (
    event.type === "caller_work_claim_released" &&
    typeof payload.job_id === "string" &&
    typeof payload.claim_id === "string" &&
    Number.isSafeInteger(payload.fencing_token)
  ) {
    const existing = state.jobs[payload.job_id];
    const claim = existing?.callerWork?.claim;
    if (
      !existing ||
      !claim ||
      existing.status !== "pending" ||
      claim.startedAt !== null ||
      claim.claimId !== payload.claim_id ||
      claim.fencingToken !== payload.fencing_token ||
      payload.caller_id !== claim.callerId
    ) {
      return state;
    }
    return {
      ...state,
      jobs: {
        ...state.jobs,
        [existing.jobId]: {
          ...existing,
          callerWork: {
            claim: null,
            nextFencingToken: existing.callerWork?.nextFencingToken ?? claim.fencingToken,
          },
        },
      },
    };
  }
  if (
    event.type === "caller_work_became_ambiguous" &&
    typeof payload.job_id === "string" &&
    typeof payload.claim_id === "string" &&
    Number.isSafeInteger(payload.fencing_token)
  ) {
    const existing = state.jobs[payload.job_id];
    const claim = existing?.callerWork?.claim;
    if (
      !existing ||
      !claim ||
      existing.status !== "running" ||
      claim.startedAt === null ||
      claim.claimId !== payload.claim_id ||
      claim.fencingToken !== payload.fencing_token ||
      payload.caller_id !== claim.callerId
    ) {
      return state;
    }
    return {
      ...state,
      jobs: {
        ...state.jobs,
        [existing.jobId]: {
          ...existing,
          status: "ambiguous",
          error:
            typeof payload.reason === "string"
              ? payload.reason
              : "Caller work ownership expired after local work started.",
        },
      },
    };
  }
  if (event.type === "job_status" && typeof payload.job_id === "string") {
    const existing = state.jobs[payload.job_id];
    if (
      !existing ||
      typeof payload.status !== "string" ||
      !STORED_JOB_STATUSES.has(payload.status as StoredJobStatus)
    ) {
      return state;
    }
    const status = payload.status as StoredJobStatus;
    if (TERMINAL_JOB_STATUSES.has(existing.status) && status !== existing.status) {
      return state;
    }
    return {
      ...state,
      jobs: {
        ...state.jobs,
        [existing.jobId]: {
          ...existing,
          status,
          output: typeof payload.output === "string" ? payload.output : existing.output,
          error: typeof payload.error === "string" ? payload.error : existing.error,
          runtime: {
            ...(existing.runtime ?? {}),
            ...(typeof payload.runner_id === "string"
              ? { runnerId: payload.runner_id }
              : {}),
            ...(typeof payload.pid === "number" && Number.isSafeInteger(payload.pid)
              ? { pid: payload.pid }
              : {}),
            ...(typeof payload.model === "string" ? { model: payload.model } : {}),
            ...(typeof payload.provider === "string" ? { provider: payload.provider } : {}),
            ...(typeof payload.phase === "string" ? { phase: payload.phase } : {}),
            ...(typeof payload.last_progress_at === "string"
              ? { lastProgressAt: payload.last_progress_at }
              : {}),
          },
        },
      },
    };
  }
  if (event.type === "run_completed" && typeof payload.final_delivery_text === "string") {
    const archive = controllerConversationArchive(state);
    return {
      ...state,
      status: "complete",
      pendingControllerTurns: [],
      abandonedControllerTurns: [],
      pendingCommandExecution: null,
      finalDeliveryText: payload.final_delivery_text,
      controllerConversationArchive:
        archive.enabled && archive.status === "waiting_for_completion"
          ? { ...archive, status: "pending" }
          : archive,
    };
  }
  if (
    event.type === "controller_conversation_archive_preflight_failed" &&
    controllerConversationArchive(state).status === "pending" &&
    typeof payload.code === "string" &&
    typeof payload.message === "string"
  ) {
    return {
      ...state,
      controllerConversationArchive: {
        ...controllerConversationArchive(state),
        code: payload.code,
        message: payload.message,
      },
    };
  }
  if (
    event.type === "controller_conversation_archive_started" &&
    state.status === "complete" &&
    controllerConversationArchive(state).status === "pending" &&
    typeof payload.conversation_url === "string" &&
    state.conversationUrl !== null &&
    sameChatGptConversationUrl(payload.conversation_url, state.conversationUrl)
  ) {
    return {
      ...state,
      controllerConversationArchive: {
        ...controllerConversationArchive(state),
        status: "started",
        code: null,
        message: null,
      },
    };
  }
  if (
    event.type === "controller_conversation_archived" &&
    controllerConversationArchive(state).status === "started" &&
    typeof payload.conversation_url === "string" &&
    state.conversationUrl !== null &&
    sameChatGptConversationUrl(payload.conversation_url, state.conversationUrl) &&
    payload.proof === "conversation_url_changed" &&
    typeof payload.post_action_url === "string" &&
    payload.post_action_url.startsWith("https://chatgpt.com/") &&
    !sameChatGptConversationUrl(payload.post_action_url, state.conversationUrl)
  ) {
    return {
      ...state,
      controllerConversationArchive: {
        ...controllerConversationArchive(state),
        status: "archived",
        proof: "conversation_url_changed",
        postActionUrl: payload.post_action_url,
      },
    };
  }
  if (
    event.type === "controller_conversation_archive_ambiguous" &&
    controllerConversationArchive(state).status === "started" &&
    typeof payload.code === "string" &&
    typeof payload.message === "string"
  ) {
    return {
      ...state,
      controllerConversationArchive: {
        ...controllerConversationArchive(state),
        status: "ambiguous",
        code: payload.code,
        message: payload.message,
      },
    };
  }
  if (
    event.type === "controller_conversation_archive_failed" &&
    controllerConversationArchive(state).status === "pending" &&
    typeof payload.code === "string" &&
    typeof payload.message === "string"
  ) {
    return {
      ...state,
      controllerConversationArchive: {
        ...controllerConversationArchive(state),
        status: "failed",
        code: payload.code,
        message: payload.message,
      },
    };
  }
  if (event.type === "run_blocked" && typeof payload.reason === "string") {
    return {
      ...state,
      status: "blocked",
      pendingControllerTurns: [],
      abandonedControllerTurns: [],
      pendingCommandExecution: null,
      blockedReason: payload.reason,
      finalDeliveryText:
        typeof payload.final_delivery_text === "string" ? payload.final_delivery_text : null,
    };
  }
  if (event.type === "run_cancelled" && typeof payload.reason === "string") {
    return {
      ...state,
      status: "cancelled",
      pendingControllerTurns: [],
      abandonedControllerTurns: [],
      pendingCommandExecution: null,
      cancelledReason: payload.reason,
    };
  }
  if (event.type === "run_failed") {
    const failedRequestId =
      typeof payload.request_id === "string" ? payload.request_id : undefined;
    const failedSubmissionState =
      payload.submission_state === "submitting" ||
      payload.submission_state === "possibly_sent" ||
      payload.submission_state === "submitted"
        ? payload.submission_state
        : undefined;
    return {
      ...state,
      status: "failed",
      notSentRecovery:
        payload.code === "CONTROLLER_NOT_SENT_CONFIRMATION_CONFLICT" &&
        state.notSentRecovery !== undefined &&
        state.notSentRecovery !== null
          ? {
              ...state.notSentRecovery,
              status: "conflict",
              conflictCode: "CONTROLLER_NOT_SENT_CONFIRMATION_CONFLICT",
            }
          : state.notSentRecovery,
      pendingControllerTurns:
        failedRequestId === undefined || failedSubmissionState === undefined
          ? state.pendingControllerTurns ?? []
          : (state.pendingControllerTurns ?? []).map((turn) =>
              turn.requestId === failedRequestId
                ? { ...turn, submissionState: failedSubmissionState }
                : turn,
            ),
      lastFailure: {
        code: typeof payload.code === "string" ? payload.code : "CUELINE_INTERNAL",
        requestId: typeof payload.request_id === "string" ? payload.request_id : null,
        message: typeof payload.message === "string" ? payload.message : null,
        stage: typeof payload.stage === "string" ? payload.stage : null,
        submissionState:
          payload.submission_state === "definitely_not_sent" ||
          payload.submission_state === "requested" ||
          payload.submission_state === "submitting" ||
          payload.submission_state === "possibly_sent" ||
          payload.submission_state === "submitted"
            ? payload.submission_state
            : null,
        conversationUrl:
          typeof payload.conversation_url === "string"
            ? payload.conversation_url
            : state.conversationUrl,
      },
    };
  }
  return state;
}

export function jobObservations(state: CueLineRunState): JobObservation[] {
  return Object.values(state.jobs)
    .sort((left, right) => left.jobId.localeCompare(right.jobId))
    .map((job) => ({
      job_id: job.jobId,
      job_key: job.jobKey,
      required: job.required,
      status: job.status,
      ...(job.output === null ? {} : { output: job.output }),
      ...(job.error === null ? {} : { error: job.error }),
    }));
}
