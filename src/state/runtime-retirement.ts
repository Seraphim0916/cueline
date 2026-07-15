import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";

import { CueLineError } from "../core/errors.js";
import { atomicWriteJson } from "./atomic-write.js";
import { runPaths } from "./paths.js";

const RETIREMENT_PROTOCOL = "cueline/runtime-owner-retirement/0.1";
const RETIREMENT_EVIDENCE_FIELDS = new Set([
  "owner_id",
  "events_after_sequence",
  "retired_at",
]);
const RETIREMENT_FIELDS = new Set([
  "protocol",
  "run_id",
  "owner_id",
  "events_after_sequence",
  "retired_at",
]);
const RETIREMENT_MARKER_PATTERN = /^([a-f0-9]{24})-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;

export interface RuntimeOwnerRetirementEvidence {
  owner_id: string;
  events_after_sequence: number;
  retired_at: string;
}

interface RuntimeOwnerRetirementRecord extends RuntimeOwnerRetirementEvidence {
  protocol: typeof RETIREMENT_PROTOCOL;
  run_id: string;
}

export interface RetirementLeaseSnapshot {
  identity: string;
  retirements: RuntimeOwnerRetirementEvidence[];
  missing: boolean;
}

export function runtimeFenceAuthorityIdentity(
  fence: { generation: string; lease_source?: "legacy" | "epoch" } | undefined,
): string {
  return `${fence?.generation ?? "legacy"}:${
    fence?.lease_source ?? (fence === undefined ? "legacy" : "epoch")
  }`;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function retirementDirectory(home: string, runId: string): string {
  return `${runPaths(home, runId).runtimeLease}.retired-owners`;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export function isRuntimeOwnerRetirementEvidence(
  value: unknown,
): value is RuntimeOwnerRetirementEvidence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((field) => RETIREMENT_EVIDENCE_FIELDS.has(field)) &&
    typeof record.owner_id === "string" &&
    record.owner_id !== "" &&
    Number.isSafeInteger(record.events_after_sequence) &&
    (record.events_after_sequence as number) >= 0 &&
    canonicalTimestamp(record.retired_at)
  );
}

function ownerIdentityHash(ownerId: string): string {
  return createHash("sha256").update(ownerId).digest("hex").slice(0, 24);
}

function invalidRetirement(message: string, cause?: unknown): CueLineError {
  return new CueLineError("RUNTIME_OWNER_RETIREMENT_INVALID", message, {
    ...(cause === undefined ? {} : { cause }),
  });
}

function parseRetirement(
  source: string,
  runId: string,
  markerName: string,
): RuntimeOwnerRetirementRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw invalidRetirement("Runtime owner retirement marker is not valid JSON.", error);
  }
  const value =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  if (
    Object.keys(value).some((field) => !RETIREMENT_FIELDS.has(field)) ||
    value.protocol !== RETIREMENT_PROTOCOL ||
    value.run_id !== runId ||
    typeof value.owner_id !== "string" ||
    value.owner_id === "" ||
    !Number.isSafeInteger(value.events_after_sequence) ||
    (value.events_after_sequence as number) < 0 ||
    !canonicalTimestamp(value.retired_at)
  ) {
    throw invalidRetirement("Runtime owner retirement marker has an invalid record shape.");
  }
  const markerMatch = RETIREMENT_MARKER_PATTERN.exec(markerName);
  if (markerMatch?.[1] !== ownerIdentityHash(value.owner_id)) {
    throw invalidRetirement(
      "Runtime owner retirement marker filename does not match its owner identity.",
    );
  }
  return value as unknown as RuntimeOwnerRetirementRecord;
}

async function readMarkers(
  home: string,
  runId: string,
): Promise<RuntimeOwnerRetirementEvidence[]> {
  const directory = retirementDirectory(home, runId);
  const names = await readdir(directory).catch((error: unknown) => {
    if (isNotFound(error)) return [] as string[];
    throw error;
  });
  const retirements: RuntimeOwnerRetirementEvidence[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith(".json")).sort()) {
    retirements.push(
      parseRetirement(await readFile(`${directory}/${name}`, "utf8"), runId, name),
    );
  }
  return retirements;
}

function mergeRetirements(
  ...groups: readonly RuntimeOwnerRetirementEvidence[][]
): Map<string, number> {
  const cutoffs = new Map<string, number>();
  for (const record of groups.flat()) {
    const existing = cutoffs.get(record.owner_id);
    cutoffs.set(
      record.owner_id,
      existing === undefined
        ? record.events_after_sequence
        : Math.min(existing, record.events_after_sequence),
    );
  }
  return cutoffs;
}

export async function readStableRuntimeOwnerRetirementCutoffs(
  home: string,
  runId: string,
  readLeaseSnapshot: () => Promise<RetirementLeaseSnapshot>,
): Promise<Map<string, number>> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const before = await readLeaseSnapshot();
    const markers = await readMarkers(home, runId);
    const after = await readLeaseSnapshot();
    if (before.identity === after.identity) {
      return mergeRetirements(markers, after.retirements);
    }
    if (after.missing) {
      // release persists every immutable marker before unlinking the lease.
      // Re-read after observing the unlink so a pre-unlink directory listing
      // cannot miss the final marker batch.
      const afterUnlinkMarkers = await readMarkers(home, runId);
      const stableMissing = await readLeaseSnapshot();
      if (stableMissing.missing && stableMissing.identity === after.identity) {
        return mergeRetirements(afterUnlinkMarkers);
      }
    }
  }
  throw new Error("RUNTIME_OWNER_RETIREMENT_EVIDENCE_UNSTABLE");
}

function validateRetirement(retirement: RuntimeOwnerRetirementEvidence): void {
  if (
    !Number.isSafeInteger(retirement.events_after_sequence) ||
    retirement.events_after_sequence < 0
  ) {
    throw new CueLineError(
      "RUNTIME_TAKEOVER_EVENT_CUTOFF_INVALID",
      "Runtime takeover requires a non-negative durable event cutoff.",
    );
  }
  if (!isRuntimeOwnerRetirementEvidence(retirement)) {
    throw invalidRetirement(
      "Runtime owner retirement evidence requires a non-empty owner and canonical timestamp.",
    );
  }
}

async function persistRetirement(
  home: string,
  runId: string,
  retirement: RuntimeOwnerRetirementEvidence,
): Promise<void> {
  validateRetirement(retirement);
  const directory = retirementDirectory(home, runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const ownerHash = ownerIdentityHash(retirement.owner_id);
  await atomicWriteJson(`${directory}/${ownerHash}-${randomUUID()}.json`, {
    protocol: RETIREMENT_PROTOCOL,
    run_id: runId,
    ...retirement,
  } satisfies RuntimeOwnerRetirementRecord);
}

export async function persistRuntimeOwnerRetirements(
  home: string,
  runId: string,
  retirements: readonly RuntimeOwnerRetirementEvidence[],
): Promise<void> {
  const validated = retirements.map((retirement) => {
    validateRetirement(retirement);
    return { ...retirement };
  });
  for (const retirement of validated) {
    await persistRetirement(home, runId, retirement);
  }
}
