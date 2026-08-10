import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFileBridgeTools, type FileBridgeRequest } from "../../src/browser/claude-desktop/file-bridge.js";
import { createNodeFileBridgeFs } from "../../src/browser/claude-desktop/node-file-bridge-fs.js";

async function withTempRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cueline-bridge-"));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a published file round-trips through real disk", async () => {
  await withTempRoot(async (root) => {
    const fs = createNodeFileBridgeFs();
    await fs.mkdir(join(root, "requests"));
    const path = join(root, "requests", "req-1.json");

    await fs.writeAtomic(path, '{"id":"req-1"}');
    assert.equal(await fs.read(path), '{"id":"req-1"}');
    assert.deepEqual(
      await readdir(join(root, "requests")),
      ["req-1.json"],
      "the staging file must not survive publication",
    );

    await fs.remove(path);
    assert.equal(await fs.read(path), undefined);
  });
});

test("reading an absent file reports absence instead of throwing", async () => {
  await withTempRoot(async (root) => {
    const fs = createNodeFileBridgeFs();
    assert.equal(await fs.read(join(root, "nothing-here.json")), undefined);
  });
});

test("removing an absent file is not an error", async () => {
  await withTempRoot(async (root) => {
    const fs = createNodeFileBridgeFs();
    await fs.remove(join(root, "nothing-here.json"));
  });
});

test("mkdir creates the whole bridge path", async () => {
  await withTempRoot(async (root) => {
    const fs = createNodeFileBridgeFs();
    await fs.mkdir(join(root, "deep", "responses"));
    await fs.mkdir(join(root, "deep", "responses"));
    assert.deepEqual(await readdir(join(root, "deep")), ["responses"]);
  });
});

/**
 * Mirrors the protocol `docs/claude-desktop-host.md` requires of a host: claim
 * the request by deleting it, then act, then answer.
 */
function watchingHost(root: string, result: unknown) {
  const seen: FileBridgeRequest[] = [];
  let stop = false;
  const done = (async () => {
    while (!stop) {
      let names: string[] = [];
      try {
        names = await readdir(join(root, "requests"));
      } catch {
        names = [];
      }
      for (const name of names.filter((entry) => entry.endsWith(".json"))) {
        const path = join(root, "requests", name);
        const raw = await readFile(path, "utf8");
        await rm(path, { force: true });
        const request = JSON.parse(raw) as FileBridgeRequest;
        seen.push(request);
        const staging = join(root, "responses", `${request.id}.json.partial`);
        await writeFile(staging, JSON.stringify({ id: request.id, ok: true, result }), "utf8");
        await rename(staging, join(root, "responses", `${request.id}.json`));
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
  return {
    seen,
    async stop() {
      stop = true;
      await done;
    },
  };
}

test("a request is answered over real disk by a watching host", async () => {
  await withTempRoot(async (root) => {
    const host = watchingHost(root, "textbox [ref_6]");
    const tools = createFileBridgeTools({
      root,
      fs: createNodeFileBridgeFs(),
      pollIntervalMs: 5,
      requestTimeoutMs: 5_000,
    });

    const tree = await tools.readPage("tab-1", { interactiveOnly: true });
    await host.stop();

    assert.equal(tree, "textbox [ref_6]");
    assert.equal(host.seen[0]!.method, "readPage");
    assert.deepEqual(await readdir(join(root, "requests")), []);
    assert.deepEqual(await readdir(join(root, "responses")), []);
  });
});

test("a claiming host performs each action exactly once", async () => {
  await withTempRoot(async (root) => {
    const host = watchingHost(root, null);
    const tools = createFileBridgeTools({
      root,
      fs: createNodeFileBridgeFs(),
      pollIntervalMs: 5,
      requestTimeoutMs: 5_000,
    });

    await tools.clickRef("tab-1", "ref_7");
    await tools.clickRef("tab-1", "ref_7");
    await host.stop();

    assert.equal(
      host.seen.length,
      2,
      "two send clicks must reach the host as exactly two actions, never more",
    );
    assert.equal(new Set(host.seen.map((request) => request.id)).size, 2);
  });
});
