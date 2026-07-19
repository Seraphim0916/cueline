import { createHash } from "node:crypto";

import type { CueLineRuntimeOptions } from "../api-contracts.js";
import { CueLineError } from "../core/errors.js";
import { canonicalJson } from "../core/ids.js";
import { loadPersistedRunStore } from "../core/persisted-run.js";
import type { RunEvent } from "../state/event-log.js";
import { defaultCueLineHome, runPaths } from "../state/paths.js";
import { readAuthoritativeRunEvents } from "../state/store.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;
const KNOWN_EVENT_TYPES = new Set([
  "caller_job_result_submitted",
  "caller_jobs_ready",
  "caller_work_became_ambiguous",
  "caller_work_claim_released",
  "caller_work_claimed",
  "caller_work_heartbeat",
  "caller_work_result_submission_started",
  "caller_work_result_submitted",
  "caller_work_started",
  "controller_command_accepted",
  "controller_command_execution_completed",
  "controller_conversation_archive_ambiguous",
  "controller_conversation_archive_failed",
  "controller_conversation_archive_preflight_failed",
  "controller_conversation_archive_started",
  "controller_conversation_archived",
  "controller_conversation_bound",
  "controller_repair_requested",
  "controller_response_evidence_rejected",
  "controller_response_received",
  "controller_response_reconciled",
  "controller_response_rejected",
  "controller_submission_succeeded",
  "controller_turn_abandoned",
  "controller_turn_manual_submission_confirmed",
  "controller_turn_not_sent_confirmed",
  "controller_turn_requested",
  "controller_turn_retry_conflict",
  "controller_turn_submission_started",
  "controller_turn_submitted",
  "job_cancellation_requested",
  "job_registered",
  "job_status",
  "notice",
  "run_blocked",
  "run_cancellation_requested",
  "run_cancelled",
  "run_completed",
  "run_created",
  "run_failed",
  "run_resumed",
  "runtime_dead_owner_retired",
  "runtime_owner_loss_reconciled",
  "runtime_reconciliation_started",
  "runtime_stale_caller_observer_recovered",
  "runtime_stale_owner_takeover_confirmed",
  "runtime_stale_owner_takeover_requested",
]);
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STATUS_VALUES = new Set([
  "pending",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "ambiguous",
]);
const ACTION_VALUES = new Set(["dispatch", "wait", "inspect", "complete", "blocked"]);
const STAGE_VALUES = new Set([
  "pre_submit",
  "submitting",
  "submitted",
  "reconciling",
  "runtime_reconciliation",
  "job_cancellation",
]);
const SUBMISSION_STATE_VALUES = new Set([
  "definitely_not_sent",
  "requested",
  "submitting",
  "possibly_sent",
  "submitted",
]);
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const MODEL_PATTERN = /^gpt-[A-Za-z0-9.-]{1,123}$/;

export type CueLineTimelineCategory =
  | "run"
  | "controller"
  | "job"
  | "runtime"
  | "caller_work"
  | "cancellation"
  | "other";

export interface CueLineRunTimelineEntry {
  sequence: number;
  timestamp: string | null;
  type: string;
  category: CueLineTimelineCategory;
  summary: string;
  attributes: Record<string, string | number | boolean>;
  payloadHash: string;
  ownerFingerprint?: string;
}

export interface CueLineRunTimeline {
  schema: "cueline-timeline/0.1";
  runId: string;
  sourceEventsPath: string;
  afterSequence: number;
  limit: number;
  totalEvents: number;
  latestSequence: number;
  returnedEvents: number;
  hasMore: boolean;
  nextAfterSequence: number;
  entries: CueLineRunTimelineEntry[];
}

export interface CueLineRunTimelineOptions
  extends Pick<CueLineRuntimeOptions, "home" | "environment"> {
  afterSequence?: number;
  limit?: number;
}

function safeRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function digest(value: unknown): string {
  try {
    return createHash("sha256").update(canonicalJson(value)).digest("hex");
  } catch {
    return createHash("sha256").update("[unhashable-payload]").digest("hex");
  }
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function safeToken(value: unknown): string | undefined {
  return typeof value === "string" && TOKEN_PATTERN.test(value) ? value : undefined;
}

function safePrefixedToken(value: unknown, prefix: string): string | undefined {
  const token = safeToken(value);
  return token?.startsWith(prefix) ? token : undefined;
}

function safeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

function category(type: string): CueLineTimelineCategory {
  if (type.startsWith("controller_")) return "controller";
  if (type.startsWith("caller_work_")) return "caller_work";
  if (type.startsWith("job_cancellation_")) return "cancellation";
  if (type.startsWith("job_")) return "job";
  if (type.startsWith("runtime_")) return "runtime";
  if (type.includes("cancellation")) return "cancellation";
  if (type.startsWith("run_")) return "run";
  return "other";
}

function attributesFor(payloadValue: unknown): Record<string, string | number | boolean> {
  const payload = safeRecord(payloadValue);
  const job = safeRecord(payload.job);
  const command = safeRecord(payload.command);
  const attributes: Record<string, string | number | boolean> = {};
  const requestId =
    safePrefixedToken(payload.request_id, "msg_") ??
    safePrefixedToken(command.request_id, "msg_");
  const round = safeInteger(payload.round);
  const jobId =
    safePrefixedToken(payload.job_id, "job_") ?? safePrefixedToken(job.jobId, "job_");
  const jobKey = safeToken(payload.job_key) ?? safeToken(job.jobKey);
  const status = safeToken(payload.status);
  const action = safeToken(payload.action) ?? safeToken(command.action);
  const rawCode = safeToken(payload.code);
  const code = rawCode !== undefined && CODE_PATTERN.test(rawCode) ? rawCode : undefined;
  const rawModel =
    safeToken(payload.response_model_slug) ?? safeToken(payload.selected_model_label);
  const model =
    rawModel === "Pro" || (rawModel !== undefined && MODEL_PATTERN.test(rawModel))
      ? rawModel
      : undefined;
  const runner = safeToken(payload.runner_id);
  const rawStage = safeToken(payload.stage);
  const stage = rawStage !== undefined && STAGE_VALUES.has(rawStage) ? rawStage : undefined;
  const rawSubmissionState = safeToken(payload.submission_state);
  const submissionState =
    rawSubmissionState !== undefined && SUBMISSION_STATE_VALUES.has(rawSubmissionState)
      ? rawSubmissionState
      : undefined;
  const pid = safeInteger(payload.pid);
  if (requestId !== undefined) attributes.requestId = requestId;
  if (round !== undefined) attributes.round = round;
  if (jobId !== undefined) attributes.jobId = jobId;
  if (jobKey !== undefined) attributes.jobKey = jobKey;
  if (status !== undefined && STATUS_VALUES.has(status)) attributes.status = status;
  if (action !== undefined && ACTION_VALUES.has(action)) attributes.action = action;
  if (code !== undefined) attributes.code = code;
  if (model !== undefined) attributes.model = model;
  if (runner !== undefined) attributes.runner = runner;
  if (stage !== undefined) attributes.stage = stage;
  if (submissionState !== undefined) attributes.submissionState = submissionState;
  if (pid !== undefined) attributes.pid = pid;
  if (Array.isArray(command.jobs)) attributes.jobCount = command.jobs.length;
  return attributes;
}

function summary(type: string, attributes: Record<string, string | number | boolean>): string {
  switch (type) {
    case "run_created":
      return "Run created.";
    case "controller_turn_requested":
      return "Controller turn requested.";
    case "controller_turn_not_sent_confirmed":
      return "Controller turn confirmed not sent; ready to retry.";
    case "controller_turn_retry_conflict":
      return `Controller turn retry conflict detected${attributes.code ? `: ${attributes.code}` : ""}.`;
    case "controller_submission_succeeded":
      return "Controller turn submission recorded.";
    case "controller_response_received":
      return "Matching controller response observed.";
    case "controller_command_accepted":
      return `Controller command accepted${attributes.action ? `: ${attributes.action}` : ""}.`;
    case "controller_conversation_archive_started":
      return "Controller conversation archive attempt started.";
    case "controller_conversation_archived":
      return "Controller conversation archived with navigation proof.";
    case "controller_conversation_archive_ambiguous":
      return `Controller conversation archive became ambiguous${attributes.code ? `: ${attributes.code}` : ""}.`;
    case "controller_conversation_archive_failed":
      return `Controller conversation archive preflight failed${attributes.code ? `: ${attributes.code}` : ""}.`;
    case "controller_conversation_archive_preflight_failed":
      return `Controller conversation archive remains retryable after a pre-click failure${attributes.code ? `: ${attributes.code}` : ""}.`;
    case "job_registered":
      return "Local job registered.";
    case "job_status":
      return `Job status recorded${attributes.status ? `: ${attributes.status}` : ""}.`;
    case "run_failed":
      return `Run failure recorded${attributes.code ? `: ${attributes.code}` : ""}.`;
    case "run_completed":
      return "Run completed.";
    case "run_blocked":
      return "Run blocked.";
    case "run_cancelled":
      return "Run cancelled.";
    default:
      return type === "unknown_event"
        ? "Unknown event metadata omitted."
        : `${type.replaceAll("_", " ")}.`;
  }
}

function entryFor(event: RunEvent): CueLineRunTimelineEntry {
  const type = KNOWN_EVENT_TYPES.has(event.type) ? event.type : "unknown_event";
  const attributes = attributesFor(event.payload);
  return {
    sequence: event.sequence,
    timestamp: Number.isFinite(Date.parse(event.timestamp)) ? event.timestamp : null,
    type,
    category: category(type),
    summary: summary(type, attributes),
    attributes,
    payloadHash: digest(event.payload),
    ...(event.runtime_owner_id === undefined
      ? {}
      : { ownerFingerprint: fingerprint(event.runtime_owner_id) }),
  };
}

function optionInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CueLineError(
      "RUN_TIMELINE_OPTIONS_INVALID",
      `${name} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

export function buildCueLineRunTimeline(
  runId: string,
  events: readonly RunEvent[],
  home: string,
  options: Pick<CueLineRunTimelineOptions, "afterSequence" | "limit"> = {},
): CueLineRunTimeline {
  const afterSequence = optionInteger(
    options.afterSequence ?? 0,
    "afterSequence",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const limit = optionInteger(options.limit ?? DEFAULT_LIMIT, "limit", 1, MAX_LIMIT);
  // Authoritative events can legitimately have gaps: readAuthoritativeRunEvents
  // filters out retired-owner events from anywhere in the log, so require a
  // strictly increasing positive-integer sequence rather than gapless-from-1
  // (RunStore.load tolerates the same sparse shape).
  let previousSequence = 0;
  for (const event of events) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= previousSequence) {
      throw new CueLineError(
        "RUN_TIMELINE_EVENTS_INVALID",
        `Event sequences must strictly increase as positive integers; received ${event.sequence} after ${previousSequence}.`,
      );
    }
    previousSequence = event.sequence;
  }
  const latestSequence = events.at(-1)?.sequence ?? 0;
  if (afterSequence > latestSequence) {
    throw new CueLineError(
      "RUN_TIMELINE_CURSOR_AHEAD",
      `Run '${runId}' is at event ${latestSequence}, behind requested cursor ${afterSequence}.`,
    );
  }
  const selected = events.filter((event) => event.sequence > afterSequence).slice(0, limit);
  const entries = selected.map(entryFor);
  const nextAfterSequence = entries.at(-1)?.sequence ?? afterSequence;
  return {
    schema: "cueline-timeline/0.1",
    runId,
    sourceEventsPath: runPaths(home, runId).events,
    afterSequence,
    limit,
    totalEvents: events.length,
    latestSequence,
    returnedEvents: entries.length,
    hasMore: latestSequence > nextAfterSequence,
    nextAfterSequence,
    entries,
  };
}

export async function loadCueLineRunTimeline(
  runId: string,
  options: CueLineRunTimelineOptions = {},
): Promise<CueLineRunTimeline> {
  const environment = options.environment ?? process.env;
  const home = options.home ?? defaultCueLineHome(environment);
  await loadPersistedRunStore(home, runId);
  const events = await readAuthoritativeRunEvents(home, runId);
  return buildCueLineRunTimeline(runId, events, home, options);
}
