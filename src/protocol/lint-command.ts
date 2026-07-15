import path from "node:path";

import { CueLineError } from "../core/errors.js";
import { validateControllerCommand } from "./validate-command.js";
import type {
  ControllerCommand,
  ExpectedControllerIdentity,
} from "./types.js";

const CONTROL_ENVELOPE = /<CueLineControl>([\s\S]*?)<\/CueLineControl>/g;
const BASE_FIELDS = new Set(["protocol", "run_id", "round", "request_id", "action"]);
const ACTION_FIELDS = new Set([
  "jobs",
  "job_ids",
  "wait_ms",
  "final_delivery_text",
  "reason",
]);
const ACTION_ALLOWED_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  dispatch: new Set(["jobs"]),
  wait: new Set(["job_ids", "wait_ms"]),
  inspect: new Set(["job_ids"]),
  complete: new Set(["final_delivery_text"]),
  blocked: new Set(["reason", "final_delivery_text"]),
};
const JOB_FIELDS = new Set([
  "job_key",
  "lane",
  "mode",
  "task",
  "required",
  "timeout_ms",
  "runner",
  "workdir",
  "background",
]);

export type CueLineProtocolLintSeverity = "warning" | "error";

export interface CueLineProtocolLintIssue {
  code: string;
  severity: CueLineProtocolLintSeverity;
  message: string;
  path?: string;
  suggestion?: string;
}

export interface CueLineProtocolLintRouting {
  lanes: readonly string[];
  runnerLanes: Readonly<Record<string, string>>;
}

export interface CueLineProtocolLintOptions {
  expected: ExpectedControllerIdentity;
  routing?: CueLineProtocolLintRouting;
}

export interface CueLineProtocolLintResult {
  valid: boolean;
  format: "envelope" | "json" | "unknown";
  command?: ControllerCommand;
  issues: CueLineProtocolLintIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePayload(text: string): {
  format: CueLineProtocolLintResult["format"];
  value?: unknown;
  issue?: CueLineProtocolLintIssue;
} {
  let body: string | undefined;
  for (const match of text.matchAll(CONTROL_ENVELOPE)) body = match[1];
  const format = body === undefined ? "json" : "envelope";
  const source = body ?? text;
  try {
    return { format, value: JSON.parse(source.trim()) as unknown };
  } catch {
    return {
      format: body === undefined && text.trim() === "" ? "unknown" : format,
      issue: {
        code: "CONTROL_JSON_INVALID",
        severity: "error",
        message: "The control input is not valid JSON.",
        suggestion: "Provide one complete <CueLineControl> JSON envelope or a raw JSON object.",
      },
    };
  }
}

function issueFromError(error: unknown): CueLineProtocolLintIssue {
  if (error instanceof CueLineError) {
    return { code: error.code, severity: "error", message: error.message };
  }
  return {
    code: "CONTROL_LINT_FAILED",
    severity: "error",
    message: error instanceof Error ? error.message : "Control validation failed.",
  };
}

function staticIssues(
  value: Record<string, unknown>,
  routing?: CueLineProtocolLintRouting,
): CueLineProtocolLintIssue[] {
  const issues: CueLineProtocolLintIssue[] = [];
  const allowedForAction =
    typeof value.action === "string" ? ACTION_ALLOWED_FIELDS[value.action] : undefined;
  for (const field of Object.keys(value)) {
    if (BASE_FIELDS.has(field)) continue;
    if (ACTION_FIELDS.has(field)) {
      if (allowedForAction === undefined || allowedForAction.has(field)) continue;
      issues.push({
        code: "CONTROL_FIELD_NOT_ALLOWED_FOR_ACTION",
        severity: "error",
        message: `Field '${field}' is not valid for controller action '${String(value.action)}'.`,
        path: `$.${field}`,
        suggestion: `Remove '${field}' or use the action that defines it.`,
      });
      continue;
    }
    issues.push({
      code: "CONTROL_FIELD_UNKNOWN",
      severity: "error",
      message: `Unsupported top-level controller field '${field}'.`,
      path: `$.${field}`,
      suggestion: "Remove the field or move the value to the documented action-specific field.",
    });
  }

  if (!Array.isArray(value.jobs)) return issues;
  value.jobs.forEach((candidate, index) => {
    if (!isRecord(candidate)) return;
    const prefix = `$.jobs[${index}]`;
    if ("prompt" in candidate) {
      issues.push({
        code: "LEGACY_PROMPT_FIELD",
        severity: "error",
        message: "Dispatch jobs require 'task'; 'prompt' is not a controller job field.",
        path: `${prefix}.prompt`,
        suggestion: "Rename 'prompt' to 'task' without changing its text.",
      });
    }
    if ("runner_id" in candidate) {
      issues.push({
        code: "LEGACY_RUNNER_ID_FIELD",
        severity: "error",
        message: "Dispatch jobs use optional 'runner'; 'runner_id' is unsupported.",
        path: `${prefix}.runner_id`,
        suggestion: "Rename 'runner_id' to 'runner'.",
      });
    }

    const lane = candidate.lane;
    if (routing !== undefined && typeof lane === "string" && !routing.lanes.includes(lane)) {
      const runnerLane = Object.hasOwn(routing.runnerLanes, lane)
        ? routing.runnerLanes[lane]
        : undefined;
      if (runnerLane !== undefined) {
        issues.push({
          code: "RUNNER_USED_AS_LANE",
          severity: "error",
          message: `'${lane}' is a runner ID, not a configured lane.`,
          path: `${prefix}.lane`,
          suggestion: `Use lane '${runnerLane}' and runner '${lane}'.`,
        });
      } else {
        issues.push({
          code: "ROUTE_LANE_UNKNOWN",
          severity: "error",
          message: `Lane '${lane}' is not present in the active routing configuration.`,
          path: `${prefix}.lane`,
          suggestion: `Use one of: ${routing.lanes.join(", ") || "<no enabled lanes>"}.`,
        });
      }
    }

    if (candidate.mode === "work") {
      if (typeof candidate.workdir !== "string" || candidate.workdir.trim() === "") {
        issues.push({
          code: "WORKDIR_REQUIRED",
          severity: "error",
          message: "Caller work requires the exact absolute local workdir.",
          path: `${prefix}.workdir`,
          suggestion: "Add the absolute repository or worktree path known to the local Codex.",
        });
      } else if (!path.isAbsolute(candidate.workdir)) {
        issues.push({
          code: "WORKDIR_NOT_ABSOLUTE",
          severity: "error",
          message: "Caller workdir must be absolute.",
          path: `${prefix}.workdir`,
          suggestion: "Replace the relative path with the exact absolute local worktree path.",
        });
      }
    }

    for (const field of Object.keys(candidate)) {
      if (JOB_FIELDS.has(field) || field === "prompt" || field === "runner_id") continue;
      issues.push({
        code: "CONTROL_JOB_FIELD_UNKNOWN",
        severity: "error",
        message: `Unsupported dispatch job field '${field}'.`,
        path: `${prefix}.${field}`,
        suggestion: "Remove the field and use only documented CueLine job fields.",
      });
    }
  });
  return issues;
}

export function lintControllerCommandText(
  text: string,
  options: CueLineProtocolLintOptions,
): CueLineProtocolLintResult {
  const parsed = parsePayload(text);
  if (parsed.issue !== undefined) {
    return { valid: false, format: parsed.format, issues: [parsed.issue] };
  }
  if (!isRecord(parsed.value)) {
    return {
      valid: false,
      format: parsed.format,
      issues: [
        {
          code: "CONTROL_COMMAND_INVALID",
          severity: "error",
          message: "Controller command must be a JSON object.",
        },
      ],
    };
  }

  const issues = staticIssues(parsed.value, options.routing);
  let command: ControllerCommand | undefined;
  try {
    command = validateControllerCommand(parsed.value, options.expected);
  } catch (error) {
    const validationIssue = issueFromError(error);
    if (!issues.some((issue) => issue.code === validationIssue.code)) {
      issues.push(validationIssue);
    }
  }
  const valid = issues.every((issue) => issue.severity !== "error");
  return {
    valid,
    format: parsed.format,
    ...(valid && command !== undefined ? { command } : {}),
    issues,
  };
}
