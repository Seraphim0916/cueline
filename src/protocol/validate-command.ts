import { CueLineError } from "../core/errors.js";
import {
  CUELINE_PROTOCOL,
  type BlockedCommand,
  type CompleteCommand,
  type ControllerCommand,
  type ControllerJobSpec,
  type DispatchCommand,
  type ExpectedControllerIdentity,
  type InspectCommand,
  type WaitCommand,
} from "./types.js";

const JOB_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LANE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string, details?: unknown): never {
  throw new CueLineError("CONTROL_COMMAND_INVALID", message, { details });
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    return fail(`'${key}' must be a non-empty string.`, { key });
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    return fail(`'${key}' must be a non-empty string when provided.`, { key });
  }
  return value;
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    return fail(`'${key}' must be a boolean when provided.`, { key });
  }
  return value;
}

function optionalPositiveInteger(
  record: Record<string, unknown>,
  key: string,
  maximum: number,
): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    return fail(`'${key}' must be an integer from 1 to ${maximum}.`, { key });
  }
  return value as number;
}

function optionalNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
  maximum: number,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    return fail(`'${key}' must be an integer from 0 to ${maximum}.`, { key });
  }
  return value as number;
}

function optionalStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    return fail(`'${key}' must be an array of non-empty strings.`, { key });
  }
  return [...value] as string[];
}

function validateJob(value: unknown): ControllerJobSpec {
  if (!isRecord(value)) {
    return fail("Each dispatch job must be an object.");
  }

  const unknownField = Object.keys(value).find((key) => !JOB_FIELDS.has(key));
  if (unknownField !== undefined) {
    const correction =
      unknownField === "runner_id"
        ? " Use 'runner'; 'runner_id' is not part of the CueLine controller contract."
        : "";
    throw new CueLineError(
      "CONTROL_JOB_FIELD_UNKNOWN",
      `Unsupported dispatch job field '${unknownField}'.${correction}`,
      { details: { field: unknownField } },
    );
  }

  const jobKey = requiredString(value, "job_key");
  if (!JOB_KEY_PATTERN.test(jobKey)) {
    return fail("'job_key' contains unsupported characters.", { jobKey });
  }
  const lane = requiredString(value, "lane");
  if (!LANE_PATTERN.test(lane)) {
    return fail("'lane' contains unsupported characters.", { lane });
  }
  const mode = requiredString(value, "mode");
  if (mode !== "advise" && mode !== "work") {
    throw new CueLineError("CONTROL_MODE_INVALID", `Unsupported job mode '${mode}'.`, {
      details: { mode },
    });
  }

  const job: ControllerJobSpec = {
    job_key: jobKey,
    lane,
    mode,
    task: requiredString(value, "task"),
  };
  const required = optionalBoolean(value, "required");
  const timeout = optionalPositiveInteger(value, "timeout_ms", 86_400_000);
  const runner = optionalString(value, "runner");
  const workdir = optionalString(value, "workdir");
  const background = optionalBoolean(value, "background");
  if (required !== undefined) job.required = required;
  if (timeout !== undefined) job.timeout_ms = timeout;
  if (runner !== undefined) job.runner = runner;
  if (workdir !== undefined) job.workdir = workdir;
  if (background !== undefined) job.background = background;
  return job;
}

function validateIdentity(
  record: Record<string, unknown>,
  expected: ExpectedControllerIdentity,
): void {
  if (
    record.run_id !== expected.runId ||
    record.round !== expected.round ||
    record.request_id !== expected.requestId
  ) {
    throw new CueLineError(
      "CONTROL_ID_MISMATCH",
      "Controller command identity does not match the pending request.",
      {
        details: {
          expected,
          received: {
            runId: record.run_id,
            round: record.round,
            requestId: record.request_id,
          },
        },
      },
    );
  }
}

export function validateControllerCommand(
  value: unknown,
  expected: ExpectedControllerIdentity,
): ControllerCommand {
  if (!isRecord(value)) {
    return fail("Controller command must be a JSON object.");
  }
  if (value.protocol !== CUELINE_PROTOCOL) {
    return fail(`'protocol' must be '${CUELINE_PROTOCOL}'.`);
  }
  validateIdentity(value, expected);

  const action = requiredString(value, "action");
  if (
    action !== "inspect" &&
    (value.evidence_offset !== undefined || value.evidence_hash !== undefined)
  ) {
    return fail("'evidence_offset' and 'evidence_hash' are valid only for an inspect command.", {
      action,
      field: value.evidence_offset !== undefined ? "evidence_offset" : "evidence_hash",
    });
  }
  const base = {
    protocol: CUELINE_PROTOCOL,
    run_id: expected.runId,
    round: expected.round,
    request_id: expected.requestId,
  };

  if (action === "dispatch") {
    if (!Array.isArray(value.jobs) || value.jobs.length === 0) {
      return fail("A dispatch command requires at least one job.");
    }
    const jobs = value.jobs.map(validateJob);
    const seen = new Set<string>();
    for (const job of jobs) {
      if (seen.has(job.job_key)) {
        throw new CueLineError(
          "CONTROL_DUPLICATE_JOB_KEY",
          `Duplicate job_key '${job.job_key}'.`,
          { details: { jobKey: job.job_key } },
        );
      }
      seen.add(job.job_key);
    }
    return { ...base, action, jobs } satisfies DispatchCommand;
  }

  if (action === "wait") {
    const command: WaitCommand = { ...base, action };
    const jobIds = optionalStringArray(value, "job_ids");
    const waitMs = optionalPositiveInteger(value, "wait_ms", 300_000);
    if (jobIds !== undefined) command.job_ids = jobIds;
    if (waitMs !== undefined) command.wait_ms = waitMs;
    return command;
  }

  if (action === "inspect") {
    const command: InspectCommand = { ...base, action };
    const jobIds = optionalStringArray(value, "job_ids");
    const evidenceOffset = optionalNonNegativeInteger(value, "evidence_offset", 1_000_000_000);
    const evidenceHash = optionalString(value, "evidence_hash");
    if ((evidenceOffset === undefined) !== (evidenceHash === undefined)) {
      return fail("'evidence_offset' and 'evidence_hash' must be provided together.", {
        field: "evidence_offset",
      });
    }
    if (evidenceOffset !== undefined && jobIds?.length !== 1) {
      return fail("Paginated evidence requires exactly one explicit 'job_ids' entry.", {
        field: "job_ids",
      });
    }
    if (evidenceHash !== undefined && !/^[0-9a-f]{64}$/.test(evidenceHash)) {
      return fail("'evidence_hash' must be the exact lowercase SHA-256 from evidence_window.", {
        field: "evidence_hash",
      });
    }
    if (jobIds !== undefined) command.job_ids = jobIds;
    if (evidenceOffset !== undefined) command.evidence_offset = evidenceOffset;
    if (evidenceHash !== undefined) command.evidence_hash = evidenceHash;
    return command;
  }

  if (action === "complete") {
    return {
      ...base,
      action,
      final_delivery_text: requiredString(value, "final_delivery_text"),
    } satisfies CompleteCommand;
  }

  if (action === "blocked") {
    const command: BlockedCommand = {
      ...base,
      action,
      reason: requiredString(value, "reason"),
    };
    const finalText = optionalString(value, "final_delivery_text");
    if (finalText !== undefined) command.final_delivery_text = finalText;
    return command;
  }

  return fail(`Unsupported controller action '${action}'.`, { action });
}
