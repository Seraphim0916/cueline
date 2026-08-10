import assert from "node:assert/strict";
import test from "node:test";

import {
  createFileBridgeTools,
  type FileBridgeFs,
  type FileBridgeRequest,
} from "../../src/browser/claude-desktop/file-bridge.js";
import { CueLineError } from "../../src/core/errors.js";

const ROOT = "/bridge";

interface FakeDisk {
  fs: FileBridgeFs;
  files: Map<string, string>;
  writes: string[];
  removed: string[];
  mkdirs: string[];
}

function fakeDisk(onWrite?: (path: string, contents: string) => void): FakeDisk {
  const files = new Map<string, string>();
  const writes: string[] = [];
  const removed: string[] = [];
  const mkdirs: string[] = [];
  const fs: FileBridgeFs = {
    async mkdir(directory) {
      mkdirs.push(directory);
    },
    async writeAtomic(path, contents) {
      writes.push(path);
      files.set(path, contents);
      onWrite?.(path, contents);
    },
    async read(path) {
      return files.get(path);
    },
    async remove(path) {
      removed.push(path);
      files.delete(path);
    },
  };
  return { fs, files, writes, removed, mkdirs };
}

/** Answers each published request the way a cooperating host agent would. */
function answering(reply: (request: FileBridgeRequest) => unknown) {
  const disk: FakeDisk = fakeDisk((path, contents) => {
    if (!path.includes("/requests/")) return;
    const request = JSON.parse(contents) as FileBridgeRequest;
    disk.files.set(
      `${ROOT}/responses/${request.id}.json`,
      JSON.stringify({ id: request.id, ok: true, result: reply(request) }),
    );
  });
  return disk;
}

function toolsOver(disk: FakeDisk, overrides: Partial<Parameters<typeof createFileBridgeTools>[0]> = {}) {
  return createFileBridgeTools({
    root: ROOT,
    fs: disk.fs,
    pollIntervalMs: 0,
    sleep: async () => {},
    newRequestId: () => "req-1",
    ...overrides,
  });
}

test("a call publishes one request and returns the host result", async () => {
  const disk = answering(() => [{ tabId: "tab-1", url: "https://chatgpt.com/c/run-1" }]);
  const tabs = await toolsOver(disk).listTabs();

  assert.deepEqual(tabs, [{ tabId: "tab-1", url: "https://chatgpt.com/c/run-1" }]);
  assert.deepEqual(disk.writes, [`${ROOT}/requests/req-1.json`]);
});

test("the published request names the method and its arguments", async () => {
  const seen: FileBridgeRequest[] = [];
  const disk = answering((request) => {
    seen.push(request);
    return undefined;
  });
  await toolsOver(disk).evaluate("tab-1", "(() => 1)()");

  const request = seen[0]!;
  assert.equal(request.method, "evaluate");
  assert.deepEqual(request.params, { tabId: "tab-1", source: "(() => 1)()" });
  assert.equal(request.id, "req-1");
  assert.ok(Date.parse(request.createdAt) > 0, "createdAt must be a timestamp");
});

test("readPage forwards whether the interactive-only tree was asked for", async () => {
  const seen: FileBridgeRequest[] = [];
  const disk = answering((request) => {
    seen.push(request);
    return "textbox \"Chat with ChatGPT\" [ref_6]";
  });
  const tools = toolsOver(disk);
  await tools.readPage("tab-1", { interactiveOnly: true });
  await tools.readPage("tab-1");

  assert.equal(seen[0]!.params["interactiveOnly"], true);
  assert.equal(seen[1]!.params["interactiveOnly"], false);
});

test("a settled request leaves nothing behind", async () => {
  const disk = answering(() => undefined);
  await toolsOver(disk).clickRef("tab-1", "ref_7");

  assert.deepEqual(disk.removed, [
    `${ROOT}/responses/req-1.json`,
    `${ROOT}/requests/req-1.json`,
    `${ROOT}/inflight/req-1.json`,
  ]);
  assert.equal(disk.files.size, 0);
});

test("a host failure surfaces as its own error code", async () => {
  const disk = fakeDisk((path, contents) => {
    if (!path.includes("/requests/")) return;
    const request = JSON.parse(contents) as FileBridgeRequest;
    disk.files.set(
      `${ROOT}/responses/${request.id}.json`,
      JSON.stringify({
        id: request.id,
        ok: false,
        error: { code: "HOST_TAB_CLOSED", message: "The controller tab was closed." },
      }),
    );
  });
  await assert.rejects(
    () => toolsOver(disk).tabUrl("tab-1"),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "HOST_TAB_CLOSED" &&
      error.message === "The controller tab was closed.",
  );
});

test("an unanswered request times out and is left on disk for inspection", async () => {
  const disk = fakeDisk();
  let clock = 0;
  await assert.rejects(
    () =>
      toolsOver(disk, {
        requestTimeoutMs: 10,
        now: () => clock,
        sleep: async () => {
          clock += 20;
        },
      }).activeTab(),
    (error: unknown) => error instanceof CueLineError && error.code === "HOST_BRIDGE_TIMEOUT",
  );
  assert.ok(disk.files.has(`${ROOT}/requests/req-1.json`), "the request must survive a timeout");
  assert.deepEqual(disk.removed, []);
});

test("a claimed request waits far longer than an unclaimed one", async () => {
  // A host that claimed the request is alive; its work may block on a login or
  // a question to the operator, which routinely outlasts the unclaimed budget.
  const disk = fakeDisk();
  let clock = 0;
  const tools = toolsOver(disk, {
    requestTimeoutMs: 100,
    claimedTimeoutMs: 10_000,
    now: () => clock,
    sleep: async () => {
      clock += 50;
      if (clock === 50) disk.files.delete(`${ROOT}/requests/req-1.json`);
      if (clock === 5_000) {
        disk.files.set(
          `${ROOT}/responses/req-1.json`,
          JSON.stringify({ id: "req-1", ok: true, result: "late but fine" }),
        );
      }
    },
  });

  assert.equal(await tools.readPage("tab-1"), "late but fine");
  assert.ok(clock > 100, "the unclaimed budget alone would have failed this request");
});

test("an unclaimed request still fails on the short budget", async () => {
  const disk = fakeDisk();
  let clock = 0;
  await assert.rejects(
    () =>
      toolsOver(disk, {
        requestTimeoutMs: 100,
        claimedTimeoutMs: 10_000,
        now: () => clock,
        sleep: async () => {
          clock += 50;
        },
      }).activeTab(),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "HOST_BRIDGE_TIMEOUT" &&
      (error.details as { claimed?: boolean }).claimed === false,
  );
});

test("a malformed host response is refused rather than guessed at", async () => {
  const disk = fakeDisk((path, contents) => {
    if (!path.includes("/requests/")) return;
    const request = JSON.parse(contents) as FileBridgeRequest;
    disk.files.set(`${ROOT}/responses/${request.id}.json`, "not json at all");
  });
  await assert.rejects(
    () => toolsOver(disk).listTabs(),
    (error: unknown) =>
      error instanceof CueLineError && error.code === "HOST_BRIDGE_RESPONSE_MALFORMED",
  );
});

test("a response answering a different request is refused", async () => {
  const disk = fakeDisk((path, contents) => {
    if (!path.includes("/requests/")) return;
    const request = JSON.parse(contents) as FileBridgeRequest;
    disk.files.set(
      `${ROOT}/responses/${request.id}.json`,
      JSON.stringify({ id: "req-999", ok: true, result: [] }),
    );
  });
  await assert.rejects(
    () => toolsOver(disk).listTabs(),
    (error: unknown) =>
      error instanceof CueLineError && error.code === "HOST_BRIDGE_RESPONSE_MISMATCHED",
  );
});

test("both bridge directories are created before publishing", async () => {
  const disk = answering(() => []);
  await toolsOver(disk).listTabs();
  assert.deepEqual(disk.mkdirs, [
    `${ROOT}/requests`,
    `${ROOT}/inflight`,
    `${ROOT}/responses`,
  ]);
});

test("each call takes a fresh request id", async () => {
  let n = 0;
  const disk = answering(() => []);
  const tools = createFileBridgeTools({
    root: ROOT,
    fs: disk.fs,
    pollIntervalMs: 0,
    sleep: async () => {},
    newRequestId: () => {
      n += 1;
      return `req-${String(n)}`;
    },
  });
  await tools.listTabs();
  await tools.listTabs();
  assert.deepEqual(disk.writes, [`${ROOT}/requests/req-1.json`, `${ROOT}/requests/req-2.json`]);
});
