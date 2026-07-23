import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { CueLineRuntimeOptions, CueLineRunVerificationReport } from "../api-contracts.js";
import { canonicalJson } from "../core/ids.js";
import type { CueLineResult } from "../core/controller-types.js";
import { CueLineError } from "../core/errors.js";
import { atomicCreateJson } from "../state/atomic-write.js";

export const GOALBRAID_DECISION_REQUEST_SCHEMA =
  "goalbraid-cueline-decision-request/v1" as const;
export const GOALBRAID_DECISION_RESPONSE_SCHEMA =
  "goalbraid-cueline-decision-response/v1" as const;

interface GoalbraidRunnableChild {
  goal_id: string;
  run_id: string;
  priority: number;
  depends_on: string[];
}

export interface GoalbraidDecisionRequest {
  schema: typeof GOALBRAID_DECISION_REQUEST_SCHEMA;
  request_id: string;
  request_digest: string;
  campaign_id: string;
  created_at: string;
  authority: {
    decision_controller: "cueline";
    executor: "omnilane";
    completion_authority: "goalbraid";
    advisory_only: true;
  };
  snapshot: {
    schema: "goalbraid-turning-point/v1";
    runnable_children: GoalbraidRunnableChild[];
    rollup_satisfied: boolean;
    gate: Record<string, unknown>;
  };
  response_schema: typeof GOALBRAID_DECISION_RESPONSE_SCHEMA;
}

export interface GoalbraidDecisionResponse {
  schema: typeof GOALBRAID_DECISION_RESPONSE_SCHEMA;
  request_id: string;
  request_digest: string;
  controller: "cueline";
  advisory_only: true;
  completion_authority: "goalbraid";
  created_at: string;
  delivery_digest: string;
  cueline: {
    run_id: string;
    status: "complete";
    verification: "verified";
  };
  decision: { decision: string };
}

export interface RunGoalbraidDecisionOptions
  extends Omit<CueLineRuntimeOptions, "executor" | "allowProcessExecution"> {
  requestPath: string;
  runId?: string;
}

export interface ContinueGoalbraidDecisionOptions
  extends Omit<CueLineRuntimeOptions, "executor" | "allowProcessExecution"> {
  requestPath: string;
  runId: string;
}

export interface GoalbraidDecisionPublication {
  requestId: string;
  responsePath: string;
  outcome: "published" | "already_published";
  response: GoalbraidDecisionResponse;
}

export interface GoalbraidDecisionBridgeResult {
  requestId: string;
  responsePath: string;
  published: boolean;
  outcome:
    | GoalbraidDecisionPublication["outcome"]
    | "awaiting_controller"
    | "blocked"
    | "cancelled"
    | "ready";
  cueline: CueLineResult;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CueLineError("GOALBRAID_DECISION_REQUEST_INVALID", `${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CueLineError(
      "GOALBRAID_DECISION_REQUEST_INVALID",
      `${field} must be a non-empty string.`,
    );
  }
  return value;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function expectedRequestDigest(campaignId: string, snapshot: unknown): string {
  return sha256(canonicalJson({ campaign_id: campaignId, snapshot }));
}

function validateRequest(value: unknown, requestPath: string): GoalbraidDecisionRequest {
  const request = object(value, "request");
  if (request.schema !== GOALBRAID_DECISION_REQUEST_SCHEMA) {
    throw new CueLineError(
      "GOALBRAID_DECISION_REQUEST_INVALID",
      `Unsupported Goalbraid decision request schema '${String(request.schema)}'.`,
    );
  }
  const requestId = nonEmptyString(request.request_id, "request.request_id");
  const campaignId = nonEmptyString(request.campaign_id, "request.campaign_id");
  const snapshot = object(request.snapshot, "request.snapshot");
  if (snapshot.schema !== "goalbraid-turning-point/v1") {
    throw new CueLineError(
      "GOALBRAID_DECISION_REQUEST_INVALID",
      "request.snapshot has an unsupported schema.",
    );
  }
  if (!Array.isArray(snapshot.runnable_children) || snapshot.runnable_children.length === 0) {
    throw new CueLineError(
      "GOALBRAID_DECISION_REQUEST_INVALID",
      "request.snapshot.runnable_children must be a non-empty array.",
    );
  }
  const goalIds = new Set<string>();
  for (const [index, rawChild] of snapshot.runnable_children.entries()) {
    const child = object(rawChild, `request.snapshot.runnable_children[${index}]`);
    const goalId = nonEmptyString(child.goal_id, `runnable_children[${index}].goal_id`);
    nonEmptyString(child.run_id, `runnable_children[${index}].run_id`);
    if (goalIds.has(goalId)) {
      throw new CueLineError(
        "GOALBRAID_DECISION_REQUEST_INVALID",
        `Duplicate runnable goal '${goalId}'.`,
      );
    }
    goalIds.add(goalId);
  }
  const authority = object(request.authority, "request.authority");
  if (
    authority.decision_controller !== "cueline" ||
    authority.executor !== "omnilane" ||
    authority.completion_authority !== "goalbraid" ||
    authority.advisory_only !== true
  ) {
    throw new CueLineError(
      "GOALBRAID_DECISION_AUTHORITY_INVALID",
      "The Goalbraid/CueLine/Omnilane authority boundary does not match the supported contract.",
    );
  }
  if (request.response_schema !== GOALBRAID_DECISION_RESPONSE_SCHEMA) {
    throw new CueLineError(
      "GOALBRAID_DECISION_REQUEST_INVALID",
      "request.response_schema does not match the supported response schema.",
    );
  }
  const digest = expectedRequestDigest(campaignId, snapshot);
  if (request.request_digest !== digest) {
    throw new CueLineError(
      "GOALBRAID_DECISION_REQUEST_DIGEST_MISMATCH",
      "The Goalbraid decision request digest does not match its snapshot.",
    );
  }
  if (requestId !== `gbd-${digest.slice("sha256:".length, "sha256:".length + 32)}`) {
    throw new CueLineError(
      "GOALBRAID_DECISION_REQUEST_ID_MISMATCH",
      "The Goalbraid decision request ID does not match its digest.",
    );
  }
  if (!path.isAbsolute(requestPath)) {
    throw new CueLineError(
      "GOALBRAID_DECISION_PATH_INVALID",
      "Goalbraid decision requestPath must be absolute.",
    );
  }
  if (
    path.basename(path.dirname(requestPath)) !== "requests" ||
    path.basename(requestPath) !== `${requestId}.json`
  ) {
    throw new CueLineError(
      "GOALBRAID_DECISION_PATH_INVALID",
      "Goalbraid decision requestPath must be <handoff-root>/requests/<request-id>.json.",
    );
  }
  return request as unknown as GoalbraidDecisionRequest;
}

export async function loadGoalbraidDecisionRequest(
  requestPath: string,
): Promise<GoalbraidDecisionRequest> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(requestPath, "utf8"));
  } catch (error) {
    throw new CueLineError(
      "GOALBRAID_DECISION_REQUEST_UNREADABLE",
      `Cannot read Goalbraid decision request '${requestPath}'.`,
      { cause: error },
    );
  }
  return validateRequest(value, requestPath);
}

export function goalbraidDecisionResponsePath(
  requestPath: string,
  requestId: string,
): string {
  return path.join(path.dirname(path.dirname(requestPath)), "responses", `${requestId}.json`);
}

export function buildGoalbraidDecisionPrompt(request: GoalbraidDecisionRequest): string {
  const legal = request.snapshot.runnable_children.map((child) => `select:${child.goal_id}`);
  if (request.snapshot.rollup_satisfied) legal.push("parent_done");
  legal.push("human_required");
  return [
    "You are CueLine's ChatGPT Pro decision consultant for one Goalbraid turning point.",
    "This consultation is advisory only. Goalbraid is the sole completion authority, and Omnilane is the sole executor.",
    "Do not dispatch, wait for, inspect, or perform local work. Do not add goals, alter priorities/dependencies, widen scope, waive gates, or declare the project complete.",
    `Choose exactly one decision from: ${legal.join(", ")}.`,
    "Issue a CueLine complete command whose final_delivery_text is exactly one compact JSON object and no prose:",
    '{"decision":"select:<goal_id>"} or {"decision":"human_required"}',
    "Bounded Goalbraid request:",
    canonicalJson(request),
  ].join("\n");
}

export function assertGoalbraidDecisionRunBinding(
  request: GoalbraidDecisionRequest,
  result: Pick<CueLineResult, "runId" | "state">,
): void {
  if (
    result.state.runId !== result.runId ||
    result.state.request !== buildGoalbraidDecisionPrompt(request) ||
    result.state.executor !== "caller" ||
    result.state.allowProcessExecution !== false
  ) {
    throw new CueLineError(
      "GOALBRAID_DECISION_RUN_BINDING_MISMATCH",
      "The CueLine run is not bound to this exact Goalbraid request and advice-only authority.",
    );
  }
}

export function parseGoalbraidDecisionDelivery(
  text: string,
  request: GoalbraidDecisionRequest,
): { decision: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new CueLineError(
      "GOALBRAID_DECISION_DELIVERY_INVALID",
      "CueLine final_delivery_text must be exactly one JSON object.",
      { cause: error },
    );
  }
  const delivery = object(value, "final_delivery_text");
  if (Object.keys(delivery).length !== 1 || !("decision" in delivery)) {
    throw new CueLineError(
      "GOALBRAID_DECISION_DELIVERY_INVALID",
      "CueLine final_delivery_text may contain only the decision field.",
    );
  }
  const decision = nonEmptyString(delivery.decision, "final_delivery_text.decision");
  const runnable = new Set(request.snapshot.runnable_children.map((child) => child.goal_id));
  const valid =
    decision === "human_required" ||
    (decision === "parent_done" && request.snapshot.rollup_satisfied) ||
    (decision.startsWith("select:") && runnable.has(decision.slice("select:".length).trim()));
  if (!valid) {
    throw new CueLineError(
      "GOALBRAID_DECISION_OUTSIDE_CLOSED_SET",
      `CueLine decision '${decision}' is outside the Goalbraid request's closed set.`,
    );
  }
  return { decision };
}

export async function publishGoalbraidDecisionResponse(
  requestPath: string,
  result: Pick<CueLineResult, "runId" | "status" | "finalDeliveryText" | "state">,
  verification: Pick<CueLineRunVerificationReport, "outcome">,
  options: { now?: () => Date } = {},
): Promise<GoalbraidDecisionPublication> {
  const request = await loadGoalbraidDecisionRequest(requestPath);
  assertGoalbraidDecisionRunBinding(request, result);
  if (result.status !== "complete" || result.finalDeliveryText === undefined) {
    throw new CueLineError(
      "GOALBRAID_DECISION_CONSULTATION_INCOMPLETE",
      "Only a completed CueLine consultation with final delivery may publish Goalbraid advice.",
    );
  }
  if (verification.outcome !== "verified") {
    throw new CueLineError(
      "GOALBRAID_DECISION_CUELINE_UNVERIFIED",
      "CueLine run verification must be fully verified before Goalbraid advice is published.",
    );
  }
  const decision = parseGoalbraidDecisionDelivery(result.finalDeliveryText, request);
  const responsePath = goalbraidDecisionResponsePath(requestPath, request.request_id);
  const response: GoalbraidDecisionResponse = {
    schema: GOALBRAID_DECISION_RESPONSE_SCHEMA,
    request_id: request.request_id,
    request_digest: request.request_digest,
    controller: "cueline",
    advisory_only: true,
    completion_authority: "goalbraid",
    created_at: (options.now ?? (() => new Date()))().toISOString(),
    delivery_digest: sha256(result.finalDeliveryText),
    cueline: { run_id: result.runId, status: "complete", verification: "verified" },
    decision,
  };
  const created = await atomicCreateJson(responsePath, response);
  if (!created) {
    let existing: unknown;
    try {
      existing = JSON.parse(await readFile(responsePath, "utf8"));
    } catch (error) {
      throw new CueLineError(
        "GOALBRAID_DECISION_RESPONSE_CONFLICT",
        "An existing Goalbraid decision response cannot be read.",
        { cause: error },
      );
    }
    const { created_at: _expectedCreatedAt, ...expectedStable } = response;
    const existingResponse = object(existing, "existing response") as Partial<GoalbraidDecisionResponse>;
    const { created_at: _existingCreatedAt, ...existingStable } = existingResponse;
    if (canonicalJson(existingStable) !== canonicalJson(expectedStable)) {
      throw new CueLineError(
        "GOALBRAID_DECISION_RESPONSE_CONFLICT",
        "An immutable Goalbraid response already exists with different evidence.",
      );
    }
    return {
      requestId: request.request_id,
      responsePath,
      outcome: "already_published",
      response: existing as GoalbraidDecisionResponse,
    };
  }
  return { requestId: request.request_id, responsePath, outcome: "published", response };
}
