import type { ControllerJobSpec, JobObservation } from "../protocol/types.js";
import type { RunEvent } from "../state/event-log.js";

export type CueLineRunStatus = "running" | "complete" | "blocked" | "failed";
export type StoredJobStatus = JobObservation["status"];
export type ControllerSubmissionState = "requested" | "possibly_sent" | "submitted";

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

export interface CueLineRunState {
  runId: string;
  request: string;
  status: CueLineRunStatus;
  round: number;
  conversationUrl: string | null;
  pendingControllerTurns: PendingControllerTurn[];
  lastFailure: RunFailureEvidence | null;
  jobs: Record<string, StoredJob>;
  notices: string[];
  commandHashes: string[];
  finalDeliveryText: string | null;
  blockedReason: string | null;
}

function recordPayload(event: RunEvent): Record<string, unknown> {
  if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
    return {};
  }
  return event.payload as Record<string, unknown>;
}

export function initialRunState(runId: string, request: string): CueLineRunState {
  return {
    runId,
    request,
    status: "running",
    round: 0,
    conversationUrl: null,
    pendingControllerTurns: [],
    lastFailure: null,
    jobs: {},
    notices: [],
    commandHashes: [],
    finalDeliveryText: null,
    blockedReason: null,
  };
}

export function reduceRunState(state: CueLineRunState, event: RunEvent): CueLineRunState {
  const payload = recordPayload(event);
  if (event.type === "run_created" && typeof payload.request === "string") {
    return { ...state, request: payload.request };
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
        },
      ],
    };
  }
  if (
    event.type === "controller_conversation_bound" &&
    typeof payload.conversation_url === "string" &&
    payload.conversation_url !== ""
  ) {
    return {
      ...state,
      conversationUrl: payload.conversation_url,
      pendingControllerTurns: (state.pendingControllerTurns ?? []).map((turn) =>
        typeof payload.request_id === "string" && turn.requestId === payload.request_id
          ? { ...turn, conversationUrl: payload.conversation_url as string }
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
    const conversationUrl =
      typeof payload.conversation_url === "string" && payload.conversation_url !== ""
        ? payload.conversation_url
        : pending.conversationUrl;
    return {
      ...state,
      conversationUrl: conversationUrl ?? state.conversationUrl,
      pendingControllerTurns: (state.pendingControllerTurns ?? []).map((turn) =>
        turn.requestId !== payload.request_id
          ? turn
          : {
              ...turn,
              submissionState:
                payload.submission_state === "submitted" ? "submitted" : "possibly_sent",
              conversationUrl,
              selectedModelLabel:
                typeof payload.selected_model_label === "string"
                  ? payload.selected_model_label
                  : turn.selectedModelLabel,
              baselineAssistantMessageCount:
                typeof payload.baseline_assistant_message_count === "number"
                  ? payload.baseline_assistant_message_count
                  : turn.baselineAssistantMessageCount,
            },
      ),
    };
  }
  if (event.type === "controller_response_received") {
    return {
      ...state,
      conversationUrl:
        typeof payload.conversation_url === "string"
          ? payload.conversation_url
          : state.conversationUrl,
      pendingControllerTurns:
        typeof payload.request_id === "string"
          ? (state.pendingControllerTurns ?? []).filter(
              (turn) => turn.requestId !== payload.request_id,
            )
          : state.pendingControllerTurns ?? [],
      lastFailure: null,
    };
  }
  if (event.type === "controller_turn_abandoned" && typeof payload.request_id === "string") {
    return {
      ...state,
      pendingControllerTurns: (state.pendingControllerTurns ?? []).filter(
        (turn) => turn.requestId !== payload.request_id,
      ),
    };
  }
  if (event.type === "controller_command_accepted" && typeof payload.command_hash === "string") {
    return { ...state, commandHashes: [...state.commandHashes, payload.command_hash] };
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
    if (!existing || typeof payload.status !== "string") return state;
    const status = payload.status as StoredJobStatus;
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
      finalDeliveryText: payload.final_delivery_text,
    };
  }
  if (event.type === "run_blocked" && typeof payload.reason === "string") {
    return {
      ...state,
      status: "blocked",
      pendingControllerTurns: [],
      blockedReason: payload.reason,
      finalDeliveryText:
        typeof payload.final_delivery_text === "string" ? payload.final_delivery_text : null,
    };
  }
  if (event.type === "run_failed") {
    return {
      ...state,
      status: "failed",
      lastFailure: {
        code: typeof payload.code === "string" ? payload.code : "CUELINE_INTERNAL",
        requestId: typeof payload.request_id === "string" ? payload.request_id : null,
        message: typeof payload.message === "string" ? payload.message : null,
        stage: typeof payload.stage === "string" ? payload.stage : null,
        submissionState:
          payload.submission_state === "definitely_not_sent" ||
          payload.submission_state === "requested" ||
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
