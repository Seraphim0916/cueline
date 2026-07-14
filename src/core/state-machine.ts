import type { ControllerJobSpec, JobObservation } from "../protocol/types.js";
import type { RunEvent } from "../state/event-log.js";

export type CueLineRunStatus = "running" | "complete" | "blocked" | "failed";
export type StoredJobStatus = JobObservation["status"];

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
  if (event.type === "controller_turn_requested" && typeof payload.round === "number") {
    return { ...state, round: payload.round };
  }
  if (
    event.type === "controller_response_received" &&
    typeof payload.conversation_url === "string" &&
    payload.conversation_url !== ""
  ) {
    return { ...state, conversationUrl: payload.conversation_url };
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
      finalDeliveryText: payload.final_delivery_text,
    };
  }
  if (event.type === "run_blocked" && typeof payload.reason === "string") {
    return {
      ...state,
      status: "blocked",
      blockedReason: payload.reason,
      finalDeliveryText:
        typeof payload.final_delivery_text === "string" ? payload.final_delivery_text : null,
    };
  }
  if (event.type === "run_failed") {
    return { ...state, status: "failed" };
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
