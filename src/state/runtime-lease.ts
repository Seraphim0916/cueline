import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rmdir,
  stat,
  unlink,
  utimes,
} from "node:fs/promises";
import path from "node:path";

import { CueLineError } from "../core/errors.js";
import { canonicalJson } from "../core/ids.js";
import { runtimePidTag, runtimePlatform } from "../core/runtime.js";
import { validatedRuntimeHeartbeatInterval } from "../core/timing.js";
import { atomicWriteJson } from "./atomic-write.js";
import { ensurePrivateDirectory } from "./private-directory.js";
import {
  captureEventLegacyFence,
  readEvents,
  type EventLegacyFence,
} from "./event-log.js";
import { runPaths } from "./paths.js";
import {
  persistRuntimeOwnerRetirements,
  readStableRuntimeOwnerRetirementCutoffs,
  runtimeFenceAuthorityIdentity,
  type RetirementLeaseSnapshot,
  type RuntimeOwnerRetirementEvidence,
} from "./runtime-retirement.js";
import { persistRuntimeTakeoverIntent } from "./runtime-takeover-intent.js";

const LEASE_PROTOCOL = "cueline/runtime-lease/0.1";
const FENCE_PROTOCOL = "cueline/runtime-fence/0.1";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_STALE_AFTER_MS = 20_000;
const LEASE_LOCK_TIMEOUT_MS = 10_000;
const LEASE_LOCK_STALE_MS = 30_000;

interface RuntimeLeaseRecord {
  protocol: typeof LEASE_PROTOCOL;
  run_id: string;
  owner_id: string;
  pid: string;
  state: "active" | "released";
  claimed_at: string;
  heartbeat_at: string;
  released_at?: string;
  retired_owners?: RuntimeOwnerRetirementEvidence[];
}

interface RuntimeFenceRecord {
  protocol: typeof FENCE_PROTOCOL;
  run_id: string;
  generation: string;
  created_at: string;
  lease_source?: "legacy" | "epoch";
  legacy_event_fence?: EventLegacyFence;
}

interface LeaseMutationContext {
  generation: string | undefined;
  target: string;
  leaseSource: "legacy" | "epoch";
  legacyEventFence?: EventLegacyFence;
}

export type RuntimeOwnership = "active" | "stale" | "released" | "missing" | "invalid";

export interface RuntimeLeaseObservation {
  ownership: RuntimeOwnership;
  heartbeatAt?: string;
  ageMs?: number;
  ownerId?: string;
  pid?: string;
}

export interface RuntimeLeaseOptions {
  home: string;
  runId: string;
  now?: () => Date;
  heartbeatIntervalMs?: number;
  staleAfterMs?: number;
}

export interface RuntimeLeaseTakeoverOptions extends RuntimeLeaseOptions {
  expectedOwnerId: string;
  expectedHeartbeatAt: string;
  /** Test hook after durable operator intent, before lease replacement. */
  beforeReplace?: () => Promise<void>;
  /** Test/telemetry hook after the new epoch record is durable. */
  afterReplace?: () => Promise<void>;
}

function pidIsDefinitelyDead(pidTag: string): boolean {
  const pid = Number(pidTag);
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  const native = typeof process === "undefined" ? undefined : process;
  if (typeof native?.kill !== "function") return false;
  try {
    native.kill(pid, 0);
    return false;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function syncDirectory(directory: string): Promise<void> {
  if (runtimePlatform() === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function createExclusiveJson(target: string, value: unknown): Promise<void> {
  const directory = path.dirname(target);
  await ensurePrivateDirectory(directory);
  const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${canonicalJson(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, target);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withLeaseMutationLock<T>(
  home: string,
  runId: string,
  operation: (context: LeaseMutationContext) => Promise<T>,
): Promise<T> {
  const lockDirectory = `${runPaths(home, runId).runtimeLease}.lock`;
  const ownerToken = `owner-${randomUUID()}`;
  const ownerPath = `${lockDirectory}/${ownerToken}`;
  const deadline = Date.now() + LEASE_LOCK_TIMEOUT_MS;
  let reclaimed = false;
  while (true) {
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
      let handle;
      try {
        handle = await open(ownerPath, "wx", 0o600);
        await handle.writeFile(
          `${canonicalJson({
            protocol: "cueline/runtime-mutation-lock/0.1",
            owner_token: ownerToken,
            pid: runtimePidTag(),
            created_at: new Date().toISOString(),
          })}\n`,
          "utf8",
        );
        await handle.sync();
      } finally {
        await handle?.close();
      }
      break;
    } catch (error) {
      if (isNotFound(error)) {
        // A concurrent stale-empty-directory reclaimer may remove the
        // directory between mkdir and owner-token creation. No operation has
        // started yet, so retrying acquisition is safe.
        await delay(1);
        continue;
      }
      if (!isAlreadyExists(error)) throw error;
      const entries = await readdir(lockDirectory).catch(() => [] as string[]);
      const evidencePaths =
        entries.length === 0
          ? [lockDirectory]
          : entries.map((entry) => `${lockDirectory}/${entry}`);
      const newestMtime = Math.max(
        0,
        ...(await Promise.all(
          evidencePaths.map((entry) => stat(entry).then((value) => value.mtimeMs).catch(() => 0)),
        )),
      );
      const lockAge = newestMtime === 0 ? 0 : Date.now() - newestMtime;
      if (lockAge > LEASE_LOCK_STALE_MS && entries.length <= 1) {
        let removedExactEvidence = false;
        if (entries.length === 0) {
          removedExactEvidence = await rmdir(lockDirectory).then(
            () => true,
            (removeError: unknown) => {
              if (isNotFound(removeError)) return false;
              const code =
                typeof removeError === "object" && removeError !== null && "code" in removeError
                  ? removeError.code
                  : undefined;
              if (code === "ENOTEMPTY") return false;
              throw removeError;
            },
          );
        } else {
          const staleOwnerPath = `${lockDirectory}/${entries[0]}`;
          removedExactEvidence = await unlink(staleOwnerPath).then(
            () => true,
            (removeError: unknown) => {
              if (isNotFound(removeError)) return false;
              throw removeError;
            },
          );
          if (removedExactEvidence) {
            await rmdir(lockDirectory).catch((removeError) => {
              const code =
                typeof removeError === "object" && removeError !== null && "code" in removeError
                  ? removeError.code
                  : undefined;
              if (!isNotFound(removeError) && code !== "ENOTEMPTY") throw removeError;
            });
          }
        }
        if (removedExactEvidence) {
          reclaimed = true;
          continue;
        }
      }
      if (Date.now() >= deadline) {
        throw new CueLineError(
          "RUN_CLAIM_IN_PROGRESS",
          `CueLine run '${runId}' has another runtime lease mutation in progress.`,
        );
      }
      await delay(10);
    }
  }
  const heartbeat = setInterval(() => {
    const timestamp = new Date();
    void utimes(ownerPath, timestamp, timestamp).catch(() => undefined);
  }, Math.max(1_000, Math.floor(LEASE_LOCK_STALE_MS / 3)));
  heartbeat.unref();
  try {
    const context = await prepareMutationFence(home, runId, reclaimed);
    const result = await operation(context);
    const authoritativeFence = await readFenceRecord(home, runId);
    const contextIsAuthoritative =
      context.generation === undefined
        ? authoritativeFence === undefined
        : authoritativeFence?.generation === context.generation &&
          (authoritativeFence.lease_source ?? "epoch") === context.leaseSource;
    if (!contextIsAuthoritative) {
      throw new CueLineError(
        "RUNTIME_MUTATION_FENCED",
        `CueLine run '${runId}' runtime mutation was superseded by a newer fence.`,
      );
    }
    return result;
  } finally {
    clearInterval(heartbeat);
    let removedOwnToken = false;
    await unlink(ownerPath).then(
      () => {
        removedOwnToken = true;
      },
      (error: unknown) => {
        if (!isNotFound(error)) throw error;
      },
    );
    if (removedOwnToken) {
      await rmdir(lockDirectory).catch((error) => {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? error.code
            : undefined;
        if (!isNotFound(error) && code !== "ENOTEMPTY") throw error;
      });
    }
  }
}

/**
 * Serializes one authoritative state mutation with lease claim, heartbeat,
 * release, and takeover. The event payload itself still uses immutable
 * lock-free segments; this fence only closes the owner-change commit window.
 */
export async function withRuntimeLeaseMutation<T>(
  home: string,
  runId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withLeaseMutationLock(home, runId, async () => operation());
}

export async function retireDeadRuntimeLease(
  home: string,
  runId: string,
  expectedOwnerId: string,
): Promise<boolean> {
  return withLeaseMutationLock(home, runId, async ({ target }) => {
    const current = await readLeaseRecordAt(target, runId);
    if (
      current === undefined ||
      current.state !== "active" ||
      current.owner_id !== expectedOwnerId ||
      !pidIsDefinitelyDead(current.pid)
    ) {
      return false;
    }
    await persistRuntimeOwnerRetirements(home, runId, current.retired_owners ?? []);
    await unlink(target);
    return true;
  });
}
function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function parseRetiredOwners(value: unknown): RuntimeOwnerRetirementEvidence[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("RUNTIME_LEASE_INVALID");
  return value.map((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      throw new Error("RUNTIME_LEASE_INVALID");
    }
    const record = candidate as Record<string, unknown>;
    if (
      typeof record.owner_id !== "string" ||
      record.owner_id === "" ||
      !Number.isSafeInteger(record.events_after_sequence) ||
      (record.events_after_sequence as number) < 0 ||
      typeof record.retired_at !== "string"
    ) {
      throw new Error("RUNTIME_LEASE_INVALID");
    }
    return {
      owner_id: record.owner_id,
      events_after_sequence: record.events_after_sequence as number,
      retired_at: record.retired_at,
    };
  });
}

function parseLease(source: string, runId: string): RuntimeLeaseRecord {
  const value = JSON.parse(source) as Partial<RuntimeLeaseRecord>;
  if (
    value.protocol !== LEASE_PROTOCOL ||
    value.run_id !== runId ||
    typeof value.owner_id !== "string" ||
    typeof value.pid !== "string" ||
    (value.state !== "active" && value.state !== "released") ||
    typeof value.claimed_at !== "string" ||
    typeof value.heartbeat_at !== "string"
  ) {
    throw new Error("RUNTIME_LEASE_INVALID");
  }
  return {
    ...(value as RuntimeLeaseRecord),
    ...(value.retired_owners === undefined
      ? {}
      : { retired_owners: parseRetiredOwners(value.retired_owners) }),
  };
}

function parseFence(source: string, runId: string): RuntimeFenceRecord {
  const value = JSON.parse(source) as Partial<RuntimeFenceRecord>;
  if (
    value.protocol !== FENCE_PROTOCOL ||
    value.run_id !== runId ||
    typeof value.generation !== "string" ||
    value.generation === "" ||
    typeof value.created_at !== "string" ||
    (value.lease_source !== undefined &&
      value.lease_source !== "legacy" &&
      value.lease_source !== "epoch")
  ) {
    throw new Error("RUNTIME_FENCE_INVALID");
  }
  if (value.legacy_event_fence !== undefined) {
    const candidate = value.legacy_event_fence as Partial<EventLegacyFence>;
    if (
      candidate.protocol !== "cueline/event-segment-fence/0.1" ||
      !Number.isSafeInteger(candidate.legacy_event_count) ||
      (candidate.legacy_event_count as number) < 0 ||
      !Number.isSafeInteger(candidate.legacy_byte_length) ||
      (candidate.legacy_byte_length as number) < 0 ||
      typeof candidate.legacy_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(candidate.legacy_sha256)
    ) {
      throw new Error("RUNTIME_FENCE_INVALID");
    }
  }
  return {
    ...(value as RuntimeFenceRecord),
    lease_source: value.lease_source ?? "epoch",
  };
}

function runtimeFencePath(home: string, runId: string): string {
  return `${runPaths(home, runId).runtimeLease}.fence`;
}

function runtimeLeaseEpochDirectory(home: string, runId: string): string {
  return `${runPaths(home, runId).runtimeLease}.epochs`;
}

function runtimeLeaseEpochPath(home: string, runId: string, generation: string): string {
  return `${runtimeLeaseEpochDirectory(home, runId)}/${generation}.json`;
}

function runtimeFenceLeaseTarget(
  home: string,
  runId: string,
  fence: RuntimeFenceRecord,
): string {
  return (fence.lease_source ?? "epoch") === "legacy"
    ? runPaths(home, runId).runtimeLease
    : runtimeLeaseEpochPath(home, runId, fence.generation);
}

export async function readRuntimeOwnerRetirementCutoffs(
  home: string,
  runId: string,
): Promise<Map<string, number>> {
  return readStableRuntimeOwnerRetirementCutoffs(home, runId, () =>
    readRetirementLeaseSnapshot(home, runId),
  );
}

async function readRetirementLeaseSnapshot(
  home: string,
  runId: string,
): Promise<RetirementLeaseSnapshot> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const before = await readFenceRecord(home, runId);
    const target = before === undefined
      ? runPaths(home, runId).runtimeLease
      : runtimeFenceLeaseTarget(home, runId, before);
    let record: RuntimeLeaseRecord | undefined;
    let invalid = false;
    try {
      record = await readLeaseRecordAt(target, runId);
    } catch {
      invalid = true;
    }
    const after = await readFenceRecord(home, runId);
    const beforeIdentity = runtimeFenceAuthorityIdentity(before);
    const afterIdentity = runtimeFenceAuthorityIdentity(after);
    if (beforeIdentity !== afterIdentity) continue;
    if (invalid) {
      return { identity: `${afterIdentity}:invalid`, retirements: [], missing: false };
    }
    if (record === undefined) {
      return { identity: `${afterIdentity}:missing`, retirements: [], missing: true };
    }
    const retirements = record.retired_owners ?? [];
    return {
      identity: `${afterIdentity}:${record.owner_id}:${record.state}:${canonicalJson(retirements)}`,
      retirements,
      missing: false,
    };
  }
  throw new Error("RUNTIME_FENCE_UNSTABLE");
}

async function readFenceRecord(
  home: string,
  runId: string,
): Promise<RuntimeFenceRecord | undefined> {
  try {
    return parseFence(await readFile(runtimeFencePath(home, runId), "utf8"), runId);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function readLeaseRecordAt(
  target: string,
  runId: string,
): Promise<RuntimeLeaseRecord | undefined> {
  try {
    return parseLease(await readFile(target, "utf8"), runId);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function readLeaseRecord(
  home: string,
  runId: string,
): Promise<RuntimeLeaseRecord | undefined> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const before = await readFenceRecord(home, runId);
    const target =
      before === undefined
        ? runPaths(home, runId).runtimeLease
        : runtimeFenceLeaseTarget(home, runId, before);
    const record = await readLeaseRecordAt(target, runId);
    const after = await readFenceRecord(home, runId);
    if (runtimeFenceAuthorityIdentity(before) === runtimeFenceAuthorityIdentity(after)) {
      return record;
    }
  }
  throw new Error("RUNTIME_FENCE_UNSTABLE");
}

async function prepareMutationFence(
  home: string,
  runId: string,
  rotate: boolean,
): Promise<LeaseMutationContext> {
  const currentFence = await readFenceRecord(home, runId);
  if (!rotate) {
    if (currentFence === undefined) {
      return {
        generation: undefined,
        target: runPaths(home, runId).runtimeLease,
        leaseSource: "legacy",
      };
    }
    return {
      generation: currentFence.generation,
      target: runtimeFenceLeaseTarget(home, runId, currentFence),
      leaseSource: currentFence.lease_source ?? "epoch",
      ...(currentFence.legacy_event_fence === undefined
        ? {}
        : { legacyEventFence: currentFence.legacy_event_fence }),
    };
  }

  const sourceTarget = currentFence === undefined
    ? runPaths(home, runId).runtimeLease
    : runtimeFenceLeaseTarget(home, runId, currentFence);
  const currentRecord = await readLeaseRecordAt(sourceTarget, runId);
  const generation = randomUUID();
  const sourceKind = currentFence?.lease_source ?? "legacy";
  const target =
    sourceKind === "legacy"
      ? runPaths(home, runId).runtimeLease
      : runtimeLeaseEpochPath(home, runId, generation);
  if (sourceKind === "epoch") {
    await ensurePrivateDirectory(runtimeLeaseEpochDirectory(home, runId));
    if (currentRecord !== undefined) await atomicWriteJson(target, currentRecord);
  }
  const replacementFence = {
    protocol: FENCE_PROTOCOL,
    run_id: runId,
    generation,
    created_at: new Date().toISOString(),
    lease_source: sourceKind,
    ...(currentFence?.legacy_event_fence === undefined
      ? {}
      : { legacy_event_fence: currentFence.legacy_event_fence }),
  } satisfies RuntimeFenceRecord;
  if (currentFence === undefined) {
    await createExclusiveJson(runtimeFencePath(home, runId), replacementFence);
  } else {
    await atomicWriteJson(runtimeFencePath(home, runId), replacementFence);
  }
  return {
    generation,
    target,
    leaseSource: sourceKind,
    ...(currentFence?.legacy_event_fence === undefined
      ? {}
      : { legacyEventFence: currentFence.legacy_event_fence }),
  };
}

async function commitLegacyLeaseReplacement(
  home: string,
  runId: string,
  context: LeaseMutationContext,
  record: RuntimeLeaseRecord,
  legacyEventFence: EventLegacyFence,
): Promise<void> {
  if (context.leaseSource !== "legacy") {
    throw new Error("RUNTIME_LEGACY_REPLACEMENT_CONTEXT_INVALID");
  }
  const generation = context.generation ?? randomUUID();
  const target = runtimeLeaseEpochPath(home, runId, generation);
  await ensurePrivateDirectory(runtimeLeaseEpochDirectory(home, runId));
  await atomicWriteJson(target, record);
  const fence: RuntimeFenceRecord = {
    protocol: FENCE_PROTOCOL,
    run_id: runId,
    generation,
    created_at: new Date().toISOString(),
    lease_source: "epoch",
    legacy_event_fence: legacyEventFence,
  };
  try {
    if (context.generation === undefined) {
      await createExclusiveJson(runtimeFencePath(home, runId), fence);
    } else {
      const current = await readFenceRecord(home, runId);
      if (
        current?.generation !== context.generation ||
        (current.lease_source ?? "epoch") !== "legacy"
      ) {
        throw new CueLineError(
          "RUNTIME_MUTATION_FENCED",
          `CueLine run '${runId}' runtime mutation was superseded before legacy replacement.`,
        );
      }
      await atomicWriteJson(runtimeFencePath(home, runId), fence);
    }
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw new CueLineError(
        "RUNTIME_MUTATION_FENCED",
        `CueLine run '${runId}' runtime mutation lost the legacy authority commit race.`,
        { cause: error },
      );
    }
    throw error;
  }
  context.generation = generation;
  context.target = target;
  context.leaseSource = "epoch";
  context.legacyEventFence = legacyEventFence;
}

export async function readRuntimeLease(
  home: string,
  runId: string,
  options: { now?: () => Date; staleAfterMs?: number } = {},
): Promise<RuntimeLeaseObservation> {
  let record: RuntimeLeaseRecord | undefined;
  try {
    record = await readLeaseRecord(home, runId);
  } catch {
    return { ownership: "invalid" };
  }
  if (!record) return { ownership: "missing" };
  if (record.state === "released") {
    return {
      ownership: "released",
      heartbeatAt: record.heartbeat_at,
      ownerId: record.owner_id,
      pid: record.pid,
    };
  }
  const now = options.now ?? (() => new Date());
  const ageMs = Math.max(0, now().getTime() - Date.parse(record.heartbeat_at));
  const ownership =
    Number.isFinite(ageMs) && ageMs <= (options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS)
      ? "active"
      : "stale";
  return {
    ownership,
    heartbeatAt: record.heartbeat_at,
    ageMs,
    ownerId: record.owner_id,
    pid: record.pid,
  };
}

async function createExclusiveLease(target: string, record: RuntimeLeaseRecord): Promise<void> {
  await createExclusiveJson(target, record);
}

export class RuntimeLease {
  readonly #home: string;
  readonly #runId: string;
  #target: string;
  readonly #now: () => Date;
  readonly #heartbeatIntervalMs: number;
  #record: RuntimeLeaseRecord;
  #timer: NodeJS.Timeout | undefined;
  #writeChain: Promise<void> = Promise.resolve();
  #heartbeatError: unknown;
  readonly #loss = new AbortController();

  private constructor(
    home: string,
    runId: string,
    target: string,
    record: RuntimeLeaseRecord,
    now: () => Date,
    heartbeatIntervalMs: number,
  ) {
    this.#home = home;
    this.#runId = runId;
    this.#target = target;
    this.#record = record;
    this.#now = now;
    this.#heartbeatIntervalMs = heartbeatIntervalMs;
  }

  static async claim(options: RuntimeLeaseOptions): Promise<RuntimeLease> {
    const heartbeatIntervalMs = validatedRuntimeHeartbeatInterval(options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
    const now = options.now ?? (() => new Date());
    let target = "";
    const timestamp = now().toISOString();
    const record: RuntimeLeaseRecord = {
      protocol: LEASE_PROTOCOL,
      run_id: options.runId,
      owner_id: randomUUID(),
      pid: runtimePidTag(),
      state: "active",
      claimed_at: timestamp,
      heartbeat_at: timestamp,
    };
    await withLeaseMutationLock(options.home, options.runId, async (context) => {
      target = context.target;
      let current: RuntimeLeaseRecord | undefined;
      try {
        current = await readLeaseRecordAt(target, options.runId);
      } catch (error) {
        throw new CueLineError(
          "RUNTIME_LEASE_INVALID",
          `CueLine run '${options.runId}' has an unreadable runtime lease.`,
          { cause: error },
        );
      }
      if (current?.state === "active") {
        const ageMs = Math.max(0, now().getTime() - Date.parse(current.heartbeat_at));
        const stale =
          !Number.isFinite(ageMs) ||
          ageMs > (options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
        throw new CueLineError(
          stale ? "RUN_STALE_REQUIRES_TAKEOVER" : "RUN_ALREADY_ACTIVE",
          stale
            ? `CueLine run '${options.runId}' has a stale runtime lease; explicit recovery is required.`
            : `CueLine run '${options.runId}' already has an active runtime lease.`,
        );
      }
      if ((current?.retired_owners?.length ?? 0) > 0) {
        record.retired_owners = [...current!.retired_owners!];
      }
      if (current?.state === "released") {
        await persistRuntimeOwnerRetirements(
          options.home,
          options.runId,
          current.retired_owners ?? [],
        );
        if (context.leaseSource === "epoch") await unlink(target);
      }
      if (context.leaseSource === "legacy") {
        const legacyEventFence = await captureEventLegacyFence(
          runPaths(options.home, options.runId).events,
        );
        await commitLegacyLeaseReplacement(
          options.home,
          options.runId,
          context,
          record,
          legacyEventFence,
        );
        target = context.target;
        return;
      }
      try {
        await createExclusiveLease(target, record);
      } catch (error) {
        if (isAlreadyExists(error)) {
          throw new CueLineError(
            "RUN_ALREADY_ACTIVE",
            `CueLine run '${options.runId}' was claimed by another runtime.`,
            { cause: error },
          );
        }
        throw error;
      }
    });
    const lease = new RuntimeLease(
      options.home,
      options.runId,
      target,
      record,
      now,
      heartbeatIntervalMs,
    );
    lease.startHeartbeat();
    return lease;
  }

  /**
   * Replaces one exact stale lease with a fresh owner in one mutation-lock
   * transaction. There is no ownerless interval. A reclaimed mutation lock
   * rotates the authoritative epoch first, so a paused previous writer can
   * only modify its fenced-off epoch when it resumes.
   */
  static async takeoverStale(options: RuntimeLeaseTakeoverOptions): Promise<RuntimeLease> {
    const heartbeatIntervalMs = validatedRuntimeHeartbeatInterval(options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
    const now = options.now ?? (() => new Date());
    let target = "";
    const takeoverAt = now();
    const timestamp = takeoverAt.toISOString();
    const record: RuntimeLeaseRecord = {
      protocol: LEASE_PROTOCOL,
      run_id: options.runId,
      owner_id: randomUUID(),
      pid: runtimePidTag(),
      state: "active",
      claimed_at: timestamp,
      heartbeat_at: timestamp,
    };
    await withLeaseMutationLock(options.home, options.runId, async (context) => {
      target = context.target;
      let current: RuntimeLeaseRecord | undefined;
      try {
        current = await readLeaseRecordAt(target, options.runId);
      } catch (error) {
        throw new CueLineError(
          "RUNTIME_LEASE_INVALID",
          `CueLine run '${options.runId}' has an unreadable runtime lease.`,
          { cause: error },
        );
      }
      await persistRuntimeTakeoverIntent(
        options.home,
        options.runId,
        options.expectedOwnerId,
        options.expectedHeartbeatAt,
        timestamp,
      );
      if (
        current === undefined ||
        current.state !== "active" ||
        current.owner_id !== options.expectedOwnerId ||
        current.heartbeat_at !== options.expectedHeartbeatAt
      ) {
        throw new CueLineError(
          "RUNTIME_TAKEOVER_RACE",
          `CueLine run '${options.runId}' changed before the stale owner could be replaced.`,
        );
      }
      const ageMs = Math.max(
        0,
        takeoverAt.getTime() - Date.parse(current.heartbeat_at),
      );
      if (
        Number.isFinite(ageMs) &&
        ageMs <= (options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS)
      ) {
        throw new CueLineError(
          "RUNTIME_TAKEOVER_ACTIVE_REFUSED",
          `CueLine run '${options.runId}' still has a fresh runtime heartbeat.`,
        );
      }
      await options.beforeReplace?.();
      const eventsPath = runPaths(options.home, options.runId).events;
      const legacyEventFence =
        context.legacyEventFence ?? (await captureEventLegacyFence(eventsPath));
      const events = await readEvents(eventsPath, { legacyFence: legacyEventFence });
      const retirement: RuntimeOwnerRetirementEvidence = {
        owner_id: current.owner_id,
        events_after_sequence: events.at(-1)?.sequence ?? 0,
        retired_at: timestamp,
      };
      record.retired_owners = [...(current.retired_owners ?? []), retirement];
      if (context.leaseSource === "legacy") {
        await commitLegacyLeaseReplacement(
          options.home,
          options.runId,
          context,
          record,
          legacyEventFence,
        );
        target = context.target;
      } else {
        if (context.legacyEventFence === undefined) {
          const currentFence = await readFenceRecord(options.home, options.runId);
          if (currentFence === undefined || currentFence.generation !== context.generation) {
            throw new CueLineError(
              "RUNTIME_MUTATION_FENCED",
              `CueLine run '${options.runId}' runtime mutation was superseded before takeover.`,
            );
          }
          await atomicWriteJson(runtimeFencePath(options.home, options.runId), {
            ...currentFence,
            lease_source: "epoch",
            legacy_event_fence: legacyEventFence,
          } satisfies RuntimeFenceRecord);
          context.legacyEventFence = legacyEventFence;
        }
        await atomicWriteJson(target, record);
      }
      await options.afterReplace?.();
    });
    const lease = new RuntimeLease(
      options.home,
      options.runId,
      target,
      record,
      now,
      heartbeatIntervalMs,
    );
    lease.startHeartbeat();
    return lease;
  }

  get signal(): AbortSignal {
    return this.#loss.signal;
  }

  get ownerId(): string {
    return this.#record.owner_id;
  }

  private startHeartbeat(): void {
    this.#timer = setInterval(() => {
      if (this.#heartbeatError !== undefined) return;
      this.#writeChain = this.#writeChain.then(async () => {
        if (this.#heartbeatError !== undefined) return;
        try {
          await this.heartbeat();
        } catch (error) {
          if (this.#heartbeatError !== undefined) return;
          this.#heartbeatError = error;
          if (this.#timer !== undefined) {
            clearInterval(this.#timer);
            this.#timer = undefined;
          }
          this.#loss.abort(
            new CueLineError(
              "RUNTIME_LEASE_HEARTBEAT_FAILED",
              `CueLine run '${this.#record.run_id}' runtime lease heartbeat failed.`,
              { cause: error },
            ),
          );
        }
      });
    }, this.#heartbeatIntervalMs);
    this.#timer.unref();
  }

  private async heartbeat(): Promise<void> {
    await withLeaseMutationLock(
      this.#home,
      this.#runId,
      async (context) => {
        const current = await readLeaseRecordAt(context.target, this.#record.run_id);
        if (
          current === undefined ||
          current.owner_id !== this.#record.owner_id ||
          current.state !== "active"
        ) {
          throw new CueLineError(
            "RUNTIME_LEASE_LOST",
            `CueLine run '${this.#record.run_id}' runtime lease ownership changed.`,
          );
        }
        this.#target = context.target;
        this.#record = { ...this.#record, heartbeat_at: this.#now().toISOString() };
        await atomicWriteJson(this.#target, this.#record);
      },
    );
  }

  assertHealthy(): void {
    if (this.#heartbeatError === undefined) return;
    throw new CueLineError("RUNTIME_LEASE_HEARTBEAT_FAILED", `CueLine run '${this.#record.run_id}' runtime lease heartbeat failed.`, { cause: this.#heartbeatError });
  }

  async release(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    await this.#writeChain;
    await withLeaseMutationLock(
      this.#home,
      this.#runId,
      async (context) => {
        const current = await readLeaseRecordAt(context.target, this.#record.run_id)
          .catch(() => undefined);
        if (!current || current.owner_id !== this.#record.owner_id) return;
        this.#target = context.target;
        await persistRuntimeOwnerRetirements(
          this.#home,
          this.#runId,
          current.retired_owners ?? [],
        );
        await unlink(this.#target).catch((error) => {
          if (!isNotFound(error)) throw error;
        });
      },
    );
  }
}
