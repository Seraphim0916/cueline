import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

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
