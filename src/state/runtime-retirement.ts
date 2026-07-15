import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

import { CueLineError } from "../core/errors.js";
import { atomicWriteJson } from "./atomic-write.js";
import { ensurePrivateDirectory } from "./private-directory.js";
import { runPaths } from "./paths.js";

const RETIREMENT_PROTOCOL = "cueline/runtime-owner-retirement/0.1";

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

function parseRetirement(source: string, runId: string): RuntimeOwnerRetirementRecord {
  const value = JSON.parse(source) as Partial<RuntimeOwnerRetirementRecord>;
  if (
    value.protocol !== RETIREMENT_PROTOCOL ||
    value.run_id !== runId ||
    typeof value.owner_id !== "string" ||
    value.owner_id === "" ||
    !Number.isSafeInteger(value.events_after_sequence) ||
    (value.events_after_sequence as number) < 0 ||
    typeof value.retired_at !== "string"
  ) {
    throw new Error("RUNTIME_OWNER_RETIREMENT_INVALID");
  }
  return value as RuntimeOwnerRetirementRecord;
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
    retirements.push(parseRetirement(await readFile(`${directory}/${name}`, "utf8"), runId));
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

async function persistRetirement(
  home: string,
  runId: string,
  retirement: RuntimeOwnerRetirementEvidence,
): Promise<void> {
  if (
    !Number.isSafeInteger(retirement.events_after_sequence) ||
    retirement.events_after_sequence < 0
  ) {
    throw new CueLineError(
      "RUNTIME_TAKEOVER_EVENT_CUTOFF_INVALID",
      "Runtime takeover requires a non-negative durable event cutoff.",
    );
  }
  const directory = retirementDirectory(home, runId);
  await ensurePrivateDirectory(directory);
  const ownerHash = createHash("sha256")
    .update(retirement.owner_id)
    .digest("hex")
    .slice(0, 24);
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
  for (const retirement of retirements) {
    await persistRetirement(home, runId, retirement);
  }
}
