import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CueLineError } from "../../src/core/errors.js";

import {
  claimNextHostMailboxRequest,
  publishHostMailboxResponse,
  waitForHostMailboxRequest,
} from "../../src/browser/claude-desktop/host-mailbox.js";

async function fixture(id = "req-100-1") {
  const root = await mkdtemp(path.join(tmpdir(), "cueline-host-mailbox-"));
  await Promise.all([
    mkdir(path.join(root, "requests")),
    mkdir(path.join(root, "inflight")),
    mkdir(path.join(root, "responses")),
  ]);
  const request = {
    id,
    method: "evaluate",
    params: { tabId: "seed", source: "location.href" },
    createdAt: "2026-08-09T00:00:00.000Z",
  };
  await writeFile(path.join(root, "requests", `${id}.json`), JSON.stringify(request));
  return { root, request };
}

test("mailbox helper claims atomically and persists action_started before browser work", async () => {
  const { root, request } = await fixture();

  const claimed = await claimNextHostMailboxRequest(root, () => Date.parse("2026-08-09T00:00:01Z"));

  assert.deepEqual(claimed, {
    ...request,
    phase: "action_started",
    updatedAt: "2026-08-09T00:00:01.000Z",
  });
  await assert.rejects(readFile(path.join(root, "requests", `${request.id}.json`)), /ENOENT/);
  assert.equal(
    JSON.parse(await readFile(path.join(root, "inflight", `${request.id}.json`), "utf8")).phase,
    "action_started",
  );
});

test("mailbox helper publishes through action_completed and response_published", async () => {
  const { root, request } = await fixture();
  await claimNextHostMailboxRequest(root);

  await publishHostMailboxResponse(
    root,
    { id: request.id, ok: true, result: { protocol: "cueline.evaluate-result/1" } },
    () => Date.parse("2026-08-09T00:00:02Z"),
  );

  assert.equal(
    JSON.parse(await readFile(path.join(root, "inflight", `${request.id}.json`), "utf8")).phase,
    "response_published",
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(root, "responses", `${request.id}.json`), "utf8")),
    { id: request.id, ok: true, result: { protocol: "cueline.evaluate-result/1" } },
  );
});

test("mailbox waiter treats stop.flag as terminal instead of polling forever", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cueline-host-mailbox-stop-"));
  await writeFile(path.join(root, "stop.flag"), "stop\n");

  await assert.rejects(
    waitForHostMailboxRequest(root, { waitTimeoutMs: 1_000 }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "HOST_MAILBOX_STOPPED",
  );
});

const validRequest = {
  id: "req-100-1",
  method: "evaluate",
  params: { tabId: "seed", source: "location.href" },
  createdAt: "2026-08-09T00:00:00.000Z",
};

const malformedRequests: [string, string][] = [
  ["not JSON", "{ invalid JSON\n保留原文\r\n"],
  ["a number", "42"],
  ["null", "null"],
  ["an array", "[]"],
  ["a mismatched id", JSON.stringify({ ...validRequest, id: "req-100-2" })],
];
for (const field of ["id", "method", "params", "createdAt"] as const) {
  const missing: Partial<typeof validRequest> = { ...validRequest };
  delete missing[field];
  malformedRequests.push(
    [`missing ${field}`, JSON.stringify(missing)],
    [`wrongly typed ${field}`, JSON.stringify({ ...validRequest, [field]: 42 })],
  );
}
malformedRequests.push(["null params", JSON.stringify({ ...validRequest, params: null })]);

for (const [description, raw] of malformedRequests) {
  test(`mailbox rejects ${description} without losing or executing the request`, async (t) => {
    const { root, request } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const filename = `${request.id}.json`;
    const original = Buffer.from(raw);
    await writeFile(path.join(root, "requests", filename), original);

    await assert.rejects(claimNextHostMailboxRequest(root), (error: unknown) => {
      assert.ok(error instanceof CueLineError);
      assert.equal(error.code, "HOST_MAILBOX_REQUEST_MALFORMED");
      return true;
    });

    assert.deepEqual(await readdir(path.join(root, "requests")), []);
    assert.deepEqual(await readdir(path.join(root, "inflight")), []);
    assert.deepEqual(await readdir(path.join(root, "responses")), []);
    assert.deepEqual(await readdir(path.join(root, "rejected")), [filename]);
    assert.deepEqual(await readFile(path.join(root, "rejected", filename)), original);
    assert.equal(await claimNextHostMailboxRequest(root), undefined);
    assert.deepEqual(await readdir(path.join(root, "inflight")), []);
    assert.deepEqual(await readFile(path.join(root, "rejected", filename)), original);
  });
}

test("mailbox waiter times out at the configured deadline using injected time", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "cueline-host-mailbox-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const start = Date.parse("2026-08-09T00:00:00Z");
  let now = start;
  const sleeps: number[] = [];
  const timeoutMs = 75;

  await assert.rejects(waitForHostMailboxRequest(root, {
    now: () => now,
    waitTimeoutMs: timeoutMs,
    pollIntervalMs: 25,
    sleep: async (ms) => {
      sleeps.push(ms);
      assert.ok(sleeps.length <= 3, "must not keep polling after the deadline");
      now += ms;
    },
  }), (error: unknown) => {
    assert.ok(error instanceof CueLineError);
    assert.equal(error.code, "HOST_MAILBOX_WAIT_TIMEOUT");
    assert.deepEqual(error.details, { timeoutMs });
    return true;
  });

  assert.equal(now, start + timeoutMs);
  assert.deepEqual(sleeps, [25, 25, 25]);
  assert.deepEqual(await readdir(path.join(root, "inflight")), []);
});

test("mailbox waiter claims a request arriving before the deadline without real sleep", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "cueline-host-mailbox-arrival-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const start = Date.parse("2026-08-09T00:00:00Z");
  let now = start;
  const sleeps: number[] = [];
  const claimed = await waitForHostMailboxRequest(root, {
    now: () => now,
    waitTimeoutMs: 75,
    pollIntervalMs: 25,
    sleep: async (ms) => {
      sleeps.push(ms);
      assert.equal(sleeps.length, 1, "must return the newly arrived request");
      now += ms;
      await writeFile(path.join(root, "requests", `${validRequest.id}.json`), JSON.stringify(validRequest));
    },
  });

  assert.deepEqual(sleeps, [25]);
  assert.ok(now < start + 75);
  assert.deepEqual(claimed, {
    ...validRequest,
    phase: "action_started",
    updatedAt: new Date(now).toISOString(),
  });
  assert.deepEqual(await readdir(path.join(root, "requests")), []);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(root, "inflight", `${validRequest.id}.json`), "utf8")),
    claimed,
  );
  assert.equal(await claimNextHostMailboxRequest(root, () => now), undefined);
});
