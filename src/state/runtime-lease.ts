import { randomUUID } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";

import { CueLineError } from "../core/errors.js";
import { canonicalJson } from "../core/ids.js";
import { runtimePidTag } from "../core/runtime.js";
import { atomicWriteJson } from "./atomic-write.js";
import { runPaths } from "./paths.js";

const LEASE_PROTOCOL = "cueline/runtime-lease/0.1";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_STALE_AFTER_MS = 20_000;

interface RuntimeLeaseRecord {
  protocol: typeof LEASE_PROTOCOL;
  run_id: string;
  owner_id: string;
  pid: string;
  state: "active" | "released";
  claimed_at: string;
  heartbeat_at: string;
  released_at?: string;
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

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
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
  return value as RuntimeLeaseRecord;
}

async function readLeaseRecord(home: string, runId: string): Promise<RuntimeLeaseRecord | undefined> {
  try {
    return parseLease(await readFile(runPaths(home, runId).runtimeLease, "utf8"), runId);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
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
  let handle;
  try {
    handle = await open(target, "wx", 0o600);
    await handle.writeFile(`${canonicalJson(record)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

export class RuntimeLease {
  readonly #target: string;
  readonly #now: () => Date;
  readonly #heartbeatIntervalMs: number;
  #record: RuntimeLeaseRecord;
  #timer: NodeJS.Timeout | undefined;
  #writeChain: Promise<void> = Promise.resolve();
  #heartbeatError: unknown;

  private constructor(
    target: string,
    record: RuntimeLeaseRecord,
    now: () => Date,
    heartbeatIntervalMs: number,
  ) {
    this.#target = target;
    this.#record = record;
    this.#now = now;
    this.#heartbeatIntervalMs = heartbeatIntervalMs;
  }

  static async claim(options: RuntimeLeaseOptions): Promise<RuntimeLease> {
    const now = options.now ?? (() => new Date());
    const observation = await readRuntimeLease(options.home, options.runId, {
      now,
      ...(options.staleAfterMs === undefined ? {} : { staleAfterMs: options.staleAfterMs }),
    });
    if (observation.ownership === "active") {
      throw new CueLineError("RUN_ALREADY_ACTIVE", `CueLine run '${options.runId}' already has an active runtime lease.`);
    }
    if (observation.ownership === "stale") {
      throw new CueLineError("RUN_STALE_REQUIRES_TAKEOVER", `CueLine run '${options.runId}' has a stale runtime lease; explicit recovery is required.`);
    }
    if (observation.ownership === "invalid") {
      throw new CueLineError("RUNTIME_LEASE_INVALID", `CueLine run '${options.runId}' has an unreadable runtime lease.`);
    }
    const target = runPaths(options.home, options.runId).runtimeLease;
    if (observation.ownership === "released") await unlink(target).catch(() => undefined);
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
    try {
      await createExclusiveLease(target, record);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
        throw new CueLineError("RUN_ALREADY_ACTIVE", `CueLine run '${options.runId}' was claimed by another runtime.`, { cause: error });
      }
      throw error;
    }
    const lease = new RuntimeLease(
      target,
      record,
      now,
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    );
    lease.startHeartbeat();
    return lease;
  }

  private startHeartbeat(): void {
    this.#timer = setInterval(() => {
      this.#writeChain = this.#writeChain.then(async () => {
        try {
          await this.heartbeat();
        } catch (error) {
          this.#heartbeatError = error;
        }
      });
    }, this.#heartbeatIntervalMs);
    this.#timer.unref();
  }

  private async heartbeat(): Promise<void> {
    const current = parseLease(await readFile(this.#target, "utf8"), this.#record.run_id);
    if (!current || current.owner_id !== this.#record.owner_id || current.state !== "active") {
      throw new CueLineError("RUNTIME_LEASE_LOST", `CueLine run '${this.#record.run_id}' runtime lease ownership changed.`);
    }
    this.#record = { ...this.#record, heartbeat_at: this.#now().toISOString() };
    await atomicWriteJson(this.#target, this.#record);
  }

  assertHealthy(): void {
    if (this.#heartbeatError === undefined) return;
    throw new CueLineError("RUNTIME_LEASE_HEARTBEAT_FAILED", `CueLine run '${this.#record.run_id}' runtime lease heartbeat failed.`, { cause: this.#heartbeatError });
  }

  async release(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    await this.#writeChain;
    const current = await readFile(this.#target, "utf8")
      .then((source) => parseLease(source, this.#record.run_id))
      .catch(() => undefined);
    if (!current || current.owner_id !== this.#record.owner_id) return;
    const timestamp = this.#now().toISOString();
    this.#record = {
      ...this.#record,
      state: "released",
      heartbeat_at: timestamp,
      released_at: timestamp,
    };
    await atomicWriteJson(this.#target, this.#record);
  }
}
