import { createHash } from "node:crypto";

function canonicalize(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("CANONICAL_JSON_NON_FINITE_NUMBER");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`CANONICAL_JSON_UNSUPPORTED_${typeof value}`);
  }
  if (ancestors.has(value)) {
    throw new TypeError("CANONICAL_JSON_CYCLE");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalize(item, ancestors)).join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], ancestors)}`);
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value, new Set<object>());
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function commandHash(command: unknown): string {
  return digest(command);
}

export function jobId(runId: string, jobKey: string, spec: unknown): string {
  return `job_${digest({ run_id: runId, job_key: jobKey, spec }).slice(0, 32)}`;
}

export function jobSpecHash(spec: unknown): string {
  return digest(spec);
}

export function messageId(
  runId: string,
  round: number,
  direction: "controller" | "observation" | string,
  content: unknown,
): string {
  return `msg_${digest({ run_id: runId, round, direction, content }).slice(0, 32)}`;
}

export function runId(seed: unknown): string {
  return `run_${digest(seed).slice(0, 32)}`;
}
