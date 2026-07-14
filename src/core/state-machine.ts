import type {
  ControllerCommand,
  ControllerJobSpec,
  JobObservation,
} from "../protocol/types.js";
import type { RunEvent } from "../state/event-log.js";

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

export interface PendingControllerTurn {
  round: number;
  requestId: string;
  prompt: string;
  promptHash: string;
  repairAttempt: number;
  submissionState: ControllerSubmissionState;
  conversationUrl: string | null;
  selectedModelLabel: string | null;
  baselineAssistantMessageCount: number | null;
  composerPromptState: "inline_ready" | "attachment_ready" | null;
  manualSendConfirmed: boolean;
}

export interface RunFailureEvidence {
  code: string;
  requestId: string | null;
  message: string | null;
  stage: string | null;
  submissionState: "definitely_not_sent" | ControllerSubmissionState | null;
  conversationUrl: string | null;
}

export interface StoredJob {
  jobId: string;
  jobKey: string;
  required: boolean;
  spec: ControllerJobSpec;
  status: StoredJobStatus;
  output: string | null;
  error: string | null;
}

export interface PendingCommandExecution {
  command: ControllerCommand;
  commandHash: string;
}

export interface CueLineRunState {
  runId: string;
  request: string;
  executor: CueLineExecutor;
  maxRounds: number;
  status: CueLineRunStatus;
  round: number;
  conversationUrl: string | null;
  pendingControllerTurns: PendingControllerTurn[];
  abandonedControllerTurns: PendingControllerTurn[];
  lastFailure: RunFailureEvidence | null;
  jobs: Record<string, StoredJob>;
  notices: string[];
  commandHashes: string[];
  pendingCommandExecution: PendingCommandExecution | null;
  finalDeliveryText: string | null;
  blockedReason: string | null;
  cancelledReason: string | null;
}

function recordPayload(event: RunEvent): Record<string, unknown> {
  if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
    return {};
  }
  return event.payload as Record<string, unknown>;
}

function normalizedConversationUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return value;
  }
}

function preserveCanonicalConversationUrl(
  canonical: string | null,
  candidate: unknown,
): string | null {
  if (typeof candidate !== "string" || candidate === "") return canonical;
  if (
    canonical !== null &&
    normalizedConversationUrl(candidate) !== normalizedConversationUrl(canonical)
  ) {
    return canonical;
  }
  return canonical ?? candidate;
}

export function initialRunState(
  runId: string,
  request: string,
  executor: CueLineExecutor = "process",
  maxRounds = DEFAULT_MAX_ROUNDS,
): CueLineRunState {
  return {
    runId,
    request,
    executor,
    maxRounds,
    status: "running",
    round: 0,
    conversationUrl: null,
    pendingControllerTurns: [],
    abandonedControllerTurns: [],
    lastFailure: null,
    jobs: {},
    notices: [],
    commandHashes: [],
    pendingCommandExecution: null,
    finalDeliveryText: null,
    blockedReason: null,
    cancelledReason: null,
  };
}

export function reduceRunState(state: CueLineRunState, event: RunEvent): CueLineRunState {
  const payload = recordPayload(event);
  if (event.type === "run_created" && typeof payload.request === "string") {
    return {
      ...state,
      request: payload.request,
      executor: payload.executor === "caller" ? "caller" : state.executor ?? "process",
      maxRounds:
        typeof payload.max_rounds === "number" &&
        Number.isSafeInteger(payload.max_rounds) &&
        payload.max_rounds >= 1
          ? payload.max_rounds
          : state.maxRounds ?? DEFAULT_MAX_ROUNDS,
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
          baselineAssistantMessageCount: null,
          composerPromptState: null,
          manualSendConfirmed: false,
        },
      ],
      abandonedControllerTurns: (state.abandonedControllerTurns ?? []).filter(
        (turn) => turn.requestId !== payload.request_id,
      ),
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
              baselineAssistantMessageCount:
                typeof payload.baseline_assistant_message_count === "number"
                  ? payload.baseline_assistant_message_count
                  : turn.baselineAssistantMessageCount,
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
    return {
      ...state,
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
    return {
      ...state,
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
        },
      },
    };
  }
  if (event.type === "run_completed" && typeof payload.final_delivery_text === "string") {
    return {
      ...state,
      status: "complete",
      pendingControllerTurns: [],
      abandonedControllerTurns: [],
      pendingCommandExecution: null,
      finalDeliveryText: payload.final_delivery_text,
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
