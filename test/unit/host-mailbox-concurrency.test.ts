import assert from "node:assert/strict";
import fs, { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { claimNextHostMailboxRequest } from "../../src/browser/claude-desktop/host-mailbox.js";
import { CueLineError } from "../../src/core/errors.js";

const NOW = Date.parse("2026-08-09T00:00:01Z");
const directories = ["requests", "inflight", "responses", "expired", "rejected"] as const;
type Directory = typeof directories[number];

function request(id: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id, method: "evaluate", params: { source: "location.href" },
    createdAt: "2026-08-09T00:00:00.000Z", ...extra,
  });
}

async function fixture(t: TestContext, entries: Map<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cueline-mailbox-concurrency-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of directories) await mkdir(path.join(root, directory));
  for (const [id, raw] of entries) {
    await writeFile(path.join(root, "requests", `${id}.json`), raw);
  }
  return root;
}

async function assertLocations(root: string, expected: Record<Directory, string[]>): Promise<void> {
  for (const directory of directories) {
    assert.deepEqual(
      (await readdir(path.join(root, directory))).sort(),
      expected[directory].map((id) => `${id}.json`).sort(),
      `${directory}: exact inventory, including absence of partial files`,
    );
  }
}

for (const first of ["valid", "expired", "malformed"] as const) {
  test(`two claimers race at rename with ${first} first, without duplicate or lost IDs`, { timeout: 5_000 }, async (t) => {
    const firstId = "req-2-1";
    const valid = ["req-10-2", "req-10-10", "req-100-1"];
    const expired = ["req-3-1"];
    const rejected = ["req-4-1", "req-5-1"];
    const entries = new Map<string, string>([
      [valid[2]!, request(valid[2]!)],
      [valid[1]!, request(valid[1]!)],
      [valid[0]!, request(valid[0]!)],
      [expired[0]!, request(expired[0]!, { expiresAt: new Date(NOW).toISOString() })],
      [rejected[0]!, "{ malformed JSON\n"],
      [rejected[1]!, request("req-999-1")],
    ]);
    if (first === "valid") {
      valid.push(firstId);
      entries.set(firstId, request(firstId));
    } else if (first === "expired") {
      expired.push(firstId);
      entries.set(firstId, request(firstId, { expiresAt: new Date(NOW - 1).toISOString() }));
    } else {
      rejected.push(firstId);
      entries.set(firstId, "null");
    }
    const root = await fixture(t, entries);
    const originalRename = fs.rename;
    let arrivals = 0;
    let lostRaces = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const contestedPath = path.join(root, "requests", `${firstId}.json`);
    const renameMock = t.mock.method(fs, "rename", async (...[from, to]: Parameters<typeof fs.rename>) => {
      if (from === contestedPath) {
        arrivals += 1;
        assert.ok(arrivals <= 2);
        if (arrivals === 2) release();
        await barrier;
      }
      try {
        return await originalRename(from, to);
      } catch (error) {
        if (from === contestedPath && (error as NodeJS.ErrnoException).code === "ENOENT") {
          lostRaces += 1;
        }
        throw error;
      }
    });
    // Named ESM imports must observe the patched builtin; all disk operations
    // still use the real filesystem. Restore bindings even if assertions fail.
    syncBuiltinESMExports();
    t.after(() => {
      release();
      renameMock.mock.restore();
      syncBuiltinESMExports();
    });

    const counts = new Map<string, number>();
    let malformedCount = 0;
    let drained = false;
    // Each wave has exactly two workers. Errors quarantine one item, then the
    // next wave continues; a fixed bound turns poison-work loops into failures.
    for (let wave = 0; wave <= entries.size; wave += 1) {
      const results = await Promise.allSettled([
        claimNextHostMailboxRequest(root, () => NOW),
        claimNextHostMailboxRequest(root, () => NOW),
      ]);
      for (const result of results) {
        if (result.status === "rejected") {
          assert.ok(result.reason instanceof CueLineError);
          assert.equal(result.reason.code, "HOST_MAILBOX_REQUEST_MALFORMED");
          malformedCount += 1;
        } else if (result.value !== undefined) {
          const claimed = result.value;
          counts.set(claimed.id, (counts.get(claimed.id) ?? 0) + 1);
          assert.equal(claimed.phase, "action_started");
          assert.equal(claimed.updatedAt, new Date(NOW).toISOString());
          assert.deepEqual(JSON.parse(await readFile(path.join(root, "inflight", `${claimed.id}.json`), "utf8")), claimed);
        }
      }
      if (results.every((result) => result.status === "fulfilled" && result.value === undefined)) {
        drained = true;
        break;
      }
    }
    assert.ok(drained, "all workers eventually observe an empty mailbox");
    assert.equal(arrivals, 2, "both workers reached the same rename barrier");
    assert.equal(lostRaces, 1, "the losing rename exercised ENOENT handling");
    assert.deepEqual([...counts.keys()].sort(), [...valid].sort());
    for (const id of valid) assert.equal(counts.get(id), 1, `${id} delivered exactly once`);
    assert.equal(malformedCount, rejected.length);
    await assertLocations(root, { requests: [], inflight: valid, responses: [], expired, rejected });
    for (const [directory, ids] of [["expired", expired], ["rejected", rejected]] as const) {
      for (const id of ids) {
        assert.equal(await readFile(path.join(root, directory, `${id}.json`), "utf8"), entries.get(id));
      }
    }
  });
}

test("claim order compares timestamp and sequence numerically, including integers beyond Number precision", async (t) => {
  const ordered = [
    "req-2-2", "req-2-10", "req-10-1",
    "req-10-9007199254740992", "req-10-9007199254740993",
    "req-9007199254740992-1", "req-9007199254740993-1",
  ];
  const root = await fixture(t, new Map([...ordered].reverse().map((id) => [id, request(id)])));
  const claimedIds: string[] = [];
  for (const expected of ordered) {
    const claimed = await claimNextHostMailboxRequest(root, () => NOW);
    assert.equal(claimed?.id, expected);
    claimedIds.push(claimed!.id);
  }
  assert.deepEqual(claimedIds, ordered);
  assert.equal(await claimNextHostMailboxRequest(root, () => NOW), undefined);
  await assertLocations(root, { requests: [], inflight: ordered, responses: [], expired: [], rejected: [] });
});
