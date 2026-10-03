import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createFileBridgeTools } from "../../src/browser/claude-desktop/file-bridge.js";
import { claimNextHostMailboxRequest } from "../../src/browser/claude-desktop/host-mailbox.js";
import { createNodeFileBridgeFs } from "../../src/browser/claude-desktop/node-file-bridge-fs.js";

// H-23: a request whose daemon already gave up must never be claimed by the
// next host turn.

async function bridgeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cueline-bridge-expiry-"));
  await Promise.all(
    ["requests", "inflight", "responses"].map((name) => mkdir(path.join(root, name))),
  );
  return root;
}

function clock(startMs: number) {
  let current = startMs;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
  };
}

test("an unclaimed request that times out is withdrawn from requests/ into expired/", async () => {
  const root = await bridgeRoot();
  const time = clock(Date.parse("2026-10-03T00:00:00Z"));
  const tools = createFileBridgeTools({
    root,
    fs: createNodeFileBridgeFs(),
    requestTimeoutMs: 1_000,
    pollIntervalMs: 250,
    now: time.now,
    sleep: time.sleep,
    newRequestId: () => "req-1790000000000-1",
  });

  await assert.rejects(tools.activeTab(), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "HOST_BRIDGE_TIMEOUT");
    return true;
  });

  assert.deepEqual(await readdir(path.join(root, "requests")), []);
  assert.deepEqual(await readdir(path.join(root, "expired")), ["req-1790000000000-1.json"]);
});

test("published requests carry an expiry and the daemon identity", async () => {
  const root = await bridgeRoot();
  const time = clock(Date.parse("2026-10-03T00:00:00Z"));
  let seen: Record<string, unknown> | undefined;
  const fs = createNodeFileBridgeFs();
  const tools = createFileBridgeTools({
    root,
    fs: {
      ...fs,
      async writeAtomic(filePath, contents) {
        if (filePath.includes(`${path.sep}requests${path.sep}`)) {
          seen = JSON.parse(contents) as Record<string, unknown>;
        }
        await fs.writeAtomic(filePath, contents);
      },
    },
    requestTimeoutMs: 1_000,
    now: time.now,
    sleep: time.sleep,
    newRequestId: () => "req-1790000000000-1",
    daemonId: "daemon-test-1",
  });

  await assert.rejects(tools.activeTab());

  assert.ok(seen);
  assert.equal(seen["daemonId"], "daemon-test-1");
  assert.equal(seen["expiresAt"], "2026-10-03T00:00:01.000Z");
});

test("claim moves an expired request aside and claims the next live one", async () => {
  const root = await bridgeRoot();
  const nowMs = Date.parse("2026-10-03T00:10:00Z");
  const stale = {
    id: "req-1790000000000-1",
    method: "evaluate",
    params: { tabId: "t", source: "old prompt" },
    createdAt: "2026-10-03T00:00:00.000Z",
    expiresAt: "2026-10-03T00:02:00.000Z",
  };
  const live = {
    id: "req-1790000000001-2",
    method: "activeTab",
    params: {},
    createdAt: "2026-10-03T00:09:59.000Z",
    expiresAt: "2026-10-03T00:11:59.000Z",
  };
  for (const request of [stale, live]) {
    await writeFile(path.join(root, "requests", `${request.id}.json`), JSON.stringify(request));
  }

  const claimed = await claimNextHostMailboxRequest(root, () => nowMs);

  assert.equal(claimed?.id, live.id);
  assert.deepEqual(await readdir(path.join(root, "expired")), [`${stale.id}.json`]);
  assert.deepEqual(await readdir(path.join(root, "inflight")), [`${live.id}.json`]);
});

test("claim orders request ids numerically, not lexically", async () => {
  const root = await bridgeRoot();
  for (const id of ["req-1790000000000-10", "req-1790000000000-9"]) {
    await writeFile(
      path.join(root, "requests", `${id}.json`),
      JSON.stringify({
        id,
        method: "activeTab",
        params: {},
        createdAt: "2026-10-03T00:00:00.000Z",
      }),
    );
  }

  const claimed = await claimNextHostMailboxRequest(root);

  assert.equal(claimed?.id, "req-1790000000000-9");
  const remaining = await readFile(
    path.join(root, "requests", "req-1790000000000-10.json"),
    "utf8",
  );
  assert.ok(remaining.length > 0);
});
