import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

import { CueLineError } from "../core/errors.js";
import { canonicalJson } from "../core/ids.js";

const EVENT_SEGMENT_WIDTH = 16;
const EVENT_SEGMENT_PATTERN = new RegExp(`^\\d{${EVENT_SEGMENT_WIDTH}}\\.json$`);
const EVENT_SEGMENT_FENCE_NAME = "legacy-fence.json";
const EVENT_SEGMENT_FENCE_PROTOCOL = "cueline/event-segment-fence/0.1";

export interface EventLegacyFence {
  protocol: typeof EVENT_SEGMENT_FENCE_PROTOCOL;
  legacy_event_count: number;
  legacy_byte_length: number;
  legacy_sha256: string;
}

export interface ReadEventsOptions {
  /** A takeover-committed legacy prefix that must win over later JSONL suffixes. */
  legacyFence?: EventLegacyFence;
}

export interface RunEvent {
  sequence: number;
  timestamp: string;
  type: string;
  payload: unknown;
  runtime_owner_id?: string;
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function eventSegmentDirectory(file: string): string {
  return `${file}.segments`;
}

function eventSegmentName(sequence: number): string {
  return `${String(sequence).padStart(EVENT_SEGMENT_WIDTH, "0")}.json`;
}

function eventSegmentFencePath(directory: string): string {
  return path.join(directory, EVENT_SEGMENT_FENCE_NAME);
}

function sha256(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureSegmentDirectory(file: string): Promise<string> {
  const directory = eventSegmentDirectory(file);
  const parent = path.dirname(directory);
  const createdParent = await mkdir(parent, { recursive: true });
  if (createdParent !== undefined) {
    await syncDirectory(path.dirname(createdParent));
  }
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    if (!(await stat(directory)).isDirectory()) throw error;
  }
  // Persist the directory entry before relying on files within it. This is
  // intentionally unconditional: a concurrent writer can observe EEXIST
  // before the creator has finished syncing the parent.
  await syncDirectory(parent);
  return directory;
}

async function writeExclusiveDurableFile(
  directory: string,
  target: string,
  contents: string,
): Promise<void> {
  const temporary = path.join(directory, `.creating-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, target);
    await unlink(temporary).catch(() => undefined);
    // The file contents alone are insufficient: the hard-link directory entry
    // must also survive a crash before appendEvent reports success.
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

function validateEvent(value: unknown, expectedSequence: number): RunEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`EVENT_LOG_INVALID: event ${expectedSequence} is not an object`);
  }
  const record = value as Record<string, unknown>;
  if (
    record.sequence !== expectedSequence ||
    typeof record.timestamp !== "string" ||
    typeof record.type !== "string" ||
    record.type === ""
  ) {
    throw new Error(`EVENT_LOG_INVALID: malformed event ${expectedSequence}`);
  }
  if (
    record.runtime_owner_id !== undefined &&
    (typeof record.runtime_owner_id !== "string" || record.runtime_owner_id.trim() === "")
  ) {
    throw new Error(`EVENT_LOG_INVALID: malformed runtime owner for event ${expectedSequence}`);
  }
  return {
    sequence: expectedSequence,
    timestamp: record.timestamp,
    type: record.type,
    payload: record.payload,
    ...(record.runtime_owner_id === undefined
      ? {}
      : { runtime_owner_id: record.runtime_owner_id as string }),
  };
}

function parseEventLines(contents: string, expectedCount?: number): RunEvent[] {
  const lines = contents.split("\n").filter((line) => line.trim() !== "");
  if (expectedCount !== undefined && lines.length !== expectedCount) {
    throw new Error(
      `EVENT_LOG_INVALID: expected ${expectedCount} fenced legacy events, found ${lines.length}`,
    );
  }
  return lines.map((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`EVENT_LOG_INVALID: invalid JSON at line ${index + 1}`, { cause: error });
    }
    return validateEvent(parsed, index + 1);
  });
}

function legacyPrefix(contents: Buffer, eventCount: number): Buffer {
  if (eventCount === 0) return Buffer.alloc(0);
  let newlineCount = 0;
  for (let index = 0; index < contents.length; index += 1) {
    if (contents[index] !== 0x0a) continue;
    newlineCount += 1;
    if (newlineCount === eventCount) return contents.subarray(0, index + 1);
  }
  throw new Error(
    `EVENT_LOG_INVALID: legacy log contains fewer than ${eventCount} complete events`,
  );
}

async function readLegacyBytes(file: string): Promise<Buffer> {
  return readFile(file).catch((error: unknown) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return Buffer.alloc(0);
    }
    throw error;
  });
}

function parseFence(value: unknown): EventLegacyFence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("EVENT_LOG_INVALID: segment fence is not an object");
  }
  const record = value as Record<string, unknown>;
  if (
    record.protocol !== EVENT_SEGMENT_FENCE_PROTOCOL ||
    !Number.isSafeInteger(record.legacy_event_count) ||
    (record.legacy_event_count as number) < 0 ||
    !Number.isSafeInteger(record.legacy_byte_length) ||
    (record.legacy_byte_length as number) < 0 ||
    typeof record.legacy_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.legacy_sha256)
  ) {
    throw new Error("EVENT_LOG_INVALID: malformed segment fence");
  }
  return record as unknown as EventLegacyFence;
}

async function readEventSegmentFence(directory: string): Promise<EventLegacyFence | undefined> {
  try {
    return parseFence(JSON.parse(await readFile(eventSegmentFencePath(directory), "utf8")));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      throw new Error("EVENT_LOG_INVALID: invalid segment fence JSON", { cause: error });
    }
    throw error;
  }
}

async function eventSegmentNames(directory: string): Promise<string[]> {
  return (await readdir(directory))
    .filter((name) => EVENT_SEGMENT_PATTERN.test(name))
    .sort();
}

async function captureLegacyFence(file: string, directory: string): Promise<EventLegacyFence> {
  const existing = await readEventSegmentFence(directory);
  if (existing !== undefined) {
    // The fence is the durable commit point even if a crash happened before
    // the first segment hard-link was installed. Never widen that prefix from
    // a later append by a still-loaded legacy JSONL writer.
    await readFencedLegacyEvents(file, existing);
    return existing;
  }
  const names = await eventSegmentNames(directory);
  const legacyContents = await readLegacyBytes(file);
  let prefix: Buffer;
  let eventCount: number;
  if (names.length > 0) {
    const firstSegmentSequence = Number(names[0]!.slice(0, EVENT_SEGMENT_WIDTH));
    eventCount = firstSegmentSequence - 1;
    prefix = legacyPrefix(legacyContents, eventCount);
  } else {
    if (legacyContents.length > 0 && legacyContents.at(-1) !== 0x0a) {
      throw new Error("EVENT_LOG_INVALID: legacy event log is not at a complete-event boundary");
    }
    const events = parseEventLines(legacyContents.toString("utf8"));
    eventCount = events.length;
    prefix = legacyContents;
  }
  parseEventLines(prefix.toString("utf8"), eventCount);
  return {
    protocol: EVENT_SEGMENT_FENCE_PROTOCOL,
    legacy_event_count: eventCount,
    legacy_byte_length: prefix.length,
    legacy_sha256: sha256(prefix),
  };
}

async function ensureEventSegmentFence(
  file: string,
  directory: string,
): Promise<EventLegacyFence> {
  const existing = await readEventSegmentFence(directory);
  if (existing) return existing;
  const candidate =
    (await readCommittedRuntimeLegacyFence(file)) ??
    (await captureLegacyFence(file, directory));
  try {
    await writeExclusiveDurableFile(
      directory,
      eventSegmentFencePath(directory),
      `${canonicalJson(candidate)}\n`,
    );
    return candidate;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const winner = await readEventSegmentFence(directory);
    if (!winner) throw error;
    return winner;
  }
}

async function readFencedLegacyEvents(file: string, fence: EventLegacyFence): Promise<RunEvent[]> {
  const contents = await readLegacyBytes(file);
  if (contents.length < fence.legacy_byte_length) {
    throw new Error("EVENT_LOG_INVALID: fenced legacy prefix was truncated");
  }
  const prefix = contents.subarray(0, fence.legacy_byte_length);
  if (sha256(prefix) !== fence.legacy_sha256) {
    throw new Error("EVENT_LOG_INVALID: fenced legacy prefix hash mismatch");
  }
  return parseEventLines(prefix.toString("utf8"), fence.legacy_event_count);
}

function sameLegacyFence(left: EventLegacyFence, right: EventLegacyFence): boolean {
  return (
    left.protocol === right.protocol &&
    left.legacy_event_count === right.legacy_event_count &&
    left.legacy_byte_length === right.legacy_byte_length &&
    left.legacy_sha256 === right.legacy_sha256
  );
}

async function readCommittedRuntimeLegacyFence(
  file: string,
): Promise<EventLegacyFence | undefined> {
  const target = path.join(path.dirname(file), "runtime.json.fence");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      throw new Error("EVENT_LOG_INVALID: invalid runtime fence JSON", { cause: error });
    }
    throw error;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("EVENT_LOG_INVALID: malformed runtime fence");
  }
  const record = parsed as Record<string, unknown>;
  if (record.protocol !== "cueline/runtime-fence/0.1") return undefined;
  // A legacy pointer deliberately keeps the live JSONL writer authoritative.
  if (record.lease_source === "legacy") return undefined;
  return record.legacy_event_fence === undefined
    ? undefined
    : parseFence(record.legacy_event_fence);
}

/** Captures a complete legacy prefix without publishing it as authoritative. */
export async function captureEventLegacyFence(file: string): Promise<EventLegacyFence> {
  const directory = await ensureSegmentDirectory(file);
  return captureLegacyFence(file, directory);
}

export async function appendEvent(file: string, event: RunEvent): Promise<void> {
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
    throw new Error("EVENT_SEQUENCE_INVALID");
  }
  validateEvent(event, event.sequence);
  const directory = await ensureSegmentDirectory(file);
  const fence = await ensureEventSegmentFence(file, directory);
  if (event.sequence <= fence.legacy_event_count) {
    throw new CueLineError(
      "EVENT_SEQUENCE_CONFLICT",
      `CueLine event sequence ${event.sequence} belongs to the fenced legacy prefix.`,
    );
  }
  const target = path.join(directory, eventSegmentName(event.sequence));
  try {
    await writeExclusiveDurableFile(directory, target, `${canonicalJson(event)}\n`);
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw new CueLineError(
        "EVENT_SEQUENCE_CONFLICT",
        `CueLine event sequence ${event.sequence} was claimed by another writer.`,
        { cause: error },
      );
    }
    throw error;
  }
}

export async function createEventLog(file: string, event: RunEvent): Promise<void> {
  validateEvent(event, event.sequence);
  const directory = path.dirname(file);
  const created = await mkdir(directory, { recursive: true });
  if (created !== undefined) {
    await syncDirectory(path.dirname(created));
  }
  await writeExclusiveDurableFile(directory, file, `${canonicalJson(event)}\n`);
}

export async function readEvents(
  file: string,
  options: ReadEventsOptions = {},
): Promise<RunEvent[]> {
  const directory = eventSegmentDirectory(file);
  const segmentNames = await readdir(directory).catch((error: unknown) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [] as string[];
    }
    throw error;
  });
  const segments = segmentNames
    .filter((name) => EVENT_SEGMENT_PATTERN.test(name))
    .sort();
  const segmentFence = await readEventSegmentFence(directory);
  const committedFence = options.legacyFence ?? (await readCommittedRuntimeLegacyFence(file));
  if (
    segmentFence !== undefined &&
    committedFence !== undefined &&
    !sameLegacyFence(segmentFence, committedFence)
  ) {
    throw new Error("EVENT_LOG_INVALID: runtime and segment legacy fences disagree");
  }
  const fence = committedFence ?? segmentFence;
  let events: RunEvent[];
  if (fence) {
    events = await readFencedLegacyEvents(file, fence);
  } else if (segments.length > 0) {
    // Compatibility for runs written by an unreleased segmented build before
    // the durable fence existed. The first segment itself defines the frozen
    // legacy prefix; a later append will persist the explicit fence.
    const legacyCount = Number(segments[0]!.slice(0, EVENT_SEGMENT_WIDTH)) - 1;
    const prefix = legacyPrefix(await readLegacyBytes(file), legacyCount);
    events = parseEventLines(prefix.toString("utf8"), legacyCount);
  } else {
    events = parseEventLines((await readLegacyBytes(file)).toString("utf8"));
  }
  for (const name of segments) {
    const sequence = Number(name.slice(0, EVENT_SEGMENT_WIDTH));
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path.join(directory, name), "utf8"));
    } catch (error) {
      throw new Error(`EVENT_LOG_INVALID: invalid event segment '${name}'`, { cause: error });
    }
    events.push(validateEvent(parsed, sequence));
  }

  events.sort((left, right) => left.sequence - right.sequence);
  return events.map((event, index) => validateEvent(event, index + 1));
}
