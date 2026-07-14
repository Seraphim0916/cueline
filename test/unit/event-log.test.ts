import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendEvent,
  captureEventLegacyFence,
  createEventLog,
  readEvents,
  type RunEvent,
} from "../../src/state/event-log.js";

function event(sequence: number, type: string, runtimeOwnerId?: string): RunEvent {
  return {
    sequence,
    timestamp: `2026-07-15T00:00:0${sequence}.000Z`,
    type,
    payload: { source: type },
    ...(runtimeOwnerId === undefined ? {} : { runtime_owner_id: runtimeOwnerId }),
  };
}

test("a durable segment fence freezes the accepted legacy prefix", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cueline-event-fence-"));
  const file = path.join(directory, "events.jsonl");
  await writeFile(file, `${JSON.stringify(event(1, "legacy-first"))}\n`, "utf8");

  await appendEvent(file, event(2, "segmented-second", "owner-new"));

  // Simulate a <=0.1.3 process that was already loaded and appends the same
  // sequence after the segmented writer has fenced the legacy prefix.
  await appendFile(file, `${JSON.stringify(event(2, "stale-legacy-second"))}\n`, "utf8");

  const events = await readEvents(file);
  assert.deepEqual(
    events.map((item) => [item.sequence, item.type, item.runtime_owner_id]),
    [
      [1, "legacy-first", undefined],
      [2, "segmented-second", "owner-new"],
    ],
  );

  const fence = JSON.parse(
    await readFile(`${file}.segments/legacy-fence.json`, "utf8"),
  ) as Record<string, unknown>;
  assert.equal(fence.protocol, "cueline/event-segment-fence/0.1");
  assert.equal(fence.legacy_event_count, 1);
  assert.equal(typeof fence.legacy_sha256, "string");
  assert.equal((fence.legacy_sha256 as string).length, 64);

  const tampered = Buffer.from(await readFile(file));
  tampered[0] = tampered[0] === 0x7b ? 0x5b : 0x7b;
  await writeFile(file, tampered);
  await assert.rejects(readEvents(file), /fenced legacy prefix hash mismatch/);
});

test("a durable fence survives a crash before the first segment is installed", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cueline-event-fence-crash-"));
  const file = path.join(directory, "events.jsonl");
  const segmentDirectory = `${file}.segments`;
  const legacyPrefix = Buffer.from(`${JSON.stringify(event(1, "legacy-first"))}\n`);
  await writeFile(file, legacyPrefix);
  await mkdir(segmentDirectory, { recursive: true });
  const committedFence = {
    protocol: "cueline/event-segment-fence/0.1" as const,
    legacy_event_count: 1,
    legacy_byte_length: legacyPrefix.length,
    legacy_sha256: createHash("sha256").update(legacyPrefix).digest("hex"),
  };
  await writeFile(
    path.join(segmentDirectory, "legacy-fence.json"),
    `${JSON.stringify(committedFence)}\n`,
    "utf8",
  );

  // The old writer appends after the fence but before any segmented event.
  await appendFile(file, `${JSON.stringify(event(2, "late-legacy-second"))}\n`, "utf8");

  assert.deepEqual(await captureEventLegacyFence(file), committedFence);
  assert.deepEqual(
    (await readEvents(file, { legacyFence: committedFence })).map((item) => item.type),
    ["legacy-first"],
  );
});

test("the first segment append syncs the new directory entry and each hard-link", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cueline-event-durability-"));
  const file = path.join(directory, "events.jsonl");
  const parent = await open(directory, "r");
  const parentStat = await parent.stat();
  await parent.close();

  const probe = await open(directory, "r");
  const prototype = Object.getPrototypeOf(probe) as {
    sync: (this: FileHandle) => Promise<void>;
  };
  const originalSync = prototype.sync;
  let parentSyncs = 0;
  let segmentDirectorySyncs = 0;
  prototype.sync = async function patchedSync(this: FileHandle): Promise<void> {
    const metadata = await this.stat();
    if (metadata.isDirectory()) {
      if (metadata.dev === parentStat.dev && metadata.ino === parentStat.ino) {
        parentSyncs += 1;
      } else {
        segmentDirectorySyncs += 1;
      }
    }
    await originalSync.call(this);
  };
  await probe.close();

  try {
    await appendEvent(file, event(1, "first-segment", "owner-new"));
  } finally {
    prototype.sync = originalSync;
  }

  assert.equal(parentSyncs, 1, "the parent must persist the new segments directory entry");
  assert.equal(
    segmentDirectorySyncs,
    2,
    "the fence and event hard-links must each be persisted before success",
  );
});

test("initial event creation syncs its exclusive hard-link directory entry", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cueline-event-create-durable-"));
  const file = path.join(directory, "events.jsonl");
  const probe = await open(directory, "r");
  const prototype = Object.getPrototypeOf(probe) as {
    sync: (this: FileHandle) => Promise<void>;
  };
  const originalSync = prototype.sync;
  let directorySyncs = 0;
  prototype.sync = async function patchedSync(this: FileHandle): Promise<void> {
    if ((await this.stat()).isDirectory()) directorySyncs += 1;
    await originalSync.call(this);
  };
  await probe.close();

  try {
    await createEventLog(file, event(1, "initial"));
  } finally {
    prototype.sync = originalSync;
  }

  assert.equal(directorySyncs, 1);
  assert.equal((await readEvents(file))[0]?.type, "initial");
  await assert.rejects(createEventLog(file, event(1, "duplicate")), { code: "EEXIST" });
});

test("an unfenced pre-release segmented log derives and then persists its legacy cutoff", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cueline-event-upgrade-"));
  const file = path.join(directory, "events.jsonl");
  const segmentDirectory = `${file}.segments`;
  await mkdir(segmentDirectory, { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify(event(1, "legacy-first"))}\n${JSON.stringify(event(2, "stale-legacy-second"))}\n`,
    "utf8",
  );
  await writeFile(
    path.join(segmentDirectory, "0000000000000002.json"),
    `${JSON.stringify(event(2, "segmented-second", "owner-new"))}\n`,
    "utf8",
  );

  assert.deepEqual(
    (await readEvents(file)).map((item) => item.type),
    ["legacy-first", "segmented-second"],
  );

  await appendEvent(file, event(3, "segmented-third", "owner-new"));
  assert.deepEqual(
    (await readEvents(file)).map((item) => item.type),
    ["legacy-first", "segmented-second", "segmented-third"],
  );
  const fence = JSON.parse(
    await readFile(path.join(segmentDirectory, "legacy-fence.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(fence.legacy_event_count, 1);
});

test("runtime owner identity is preserved and an empty identity is rejected", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cueline-event-owner-"));
  const file = path.join(directory, "events.jsonl");

  await appendEvent(file, event(1, "owned", "owner-1"));
  assert.equal((await readEvents(file))[0]?.runtime_owner_id, "owner-1");

  await assert.rejects(
    appendEvent(file, event(2, "invalid-owner", "")),
    /EVENT_LOG_INVALID.*runtime owner/i,
  );
});
