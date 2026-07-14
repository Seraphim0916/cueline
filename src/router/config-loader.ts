import { readFile } from "node:fs/promises";

import { CueLineError } from "../core/errors.js";
import type { LaneConfig, RouteCandidate, RoutingConfig } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string, details?: unknown): CueLineError {
  return new CueLineError("ROUTING_CONFIG_INVALID", message, { details });
}

function parseCandidate(value: unknown, lane: string, index: number): RouteCandidate {
  if (!isRecord(value)) {
    throw invalid("route candidate must be an object", { lane, index });
  }

  const { id, argv, task_input, enabled } = value;
  if (typeof id !== "string" || id.trim().length === 0) {
    throw invalid("route candidate id must be a non-empty string", { lane, index });
  }
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((part) => typeof part !== "string" || part.length === 0)) {
    throw invalid("route candidate argv must contain non-empty strings", { lane, index });
  }
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw invalid("route candidate enabled must be a boolean", { lane, index });
  }
  if (task_input !== undefined && task_input !== "argv" && task_input !== "stdin") {
    throw invalid("route candidate task_input must be argv or stdin", { lane, index });
  }

  return {
    id,
    argv: [...argv] as string[],
    ...(task_input === undefined ? {} : { task_input }),
    ...(enabled === undefined ? {} : { enabled }),
  };
}

function parseLane(value: unknown, lane: string): LaneConfig {
  if (!isRecord(value)) {
    throw invalid("lane configuration must be an object", { lane });
  }

  const { enabled, candidates } = value;
  if (typeof enabled !== "boolean") {
    throw invalid("lane enabled must be a boolean", { lane });
  }
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw invalid("lane candidates must be a non-empty array", { lane });
  }

  const parsedCandidates = candidates.map((candidate, index) => parseCandidate(candidate, lane, index));
  const identifiers = new Set<string>();
  for (const candidate of parsedCandidates) {
    if (identifiers.has(candidate.id)) {
      throw invalid("lane candidate ids must be unique", { lane, id: candidate.id });
    }
    identifiers.add(candidate.id);
  }

  return { enabled, candidates: parsedCandidates };
}

export function parseRoutingConfig(value: unknown): RoutingConfig {
  if (!isRecord(value)) {
    throw invalid("routing configuration must be an object");
  }
  if (value.version !== 1) {
    throw invalid("routing configuration version must be 1", { version: value.version });
  }
  if (!isRecord(value.lanes) || Object.keys(value.lanes).length === 0) {
    throw invalid("routing configuration must define at least one lane");
  }

  const lanes: Record<string, LaneConfig> = {};
  for (const [lane, laneValue] of Object.entries(value.lanes)) {
    if (lane.trim().length === 0) {
      throw invalid("lane name must be non-empty");
    }
    lanes[lane] = parseLane(laneValue, lane);
  }

  return { version: 1, lanes };
}

export async function loadRoutingConfig(filePath: string): Promise<RoutingConfig> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    throw new CueLineError("ROUTING_CONFIG_READ_FAILED", `unable to read routing config: ${filePath}`, {
      cause: error,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new CueLineError("ROUTING_CONFIG_INVALID", "routing config is not valid JSON", { cause: error });
  }
  return parseRoutingConfig(parsed);
}
