import assert from "node:assert/strict";
import test from "node:test";

import {
  createFileBridgeTools,
  type FileBridgeFs,
  type FileBridgeRequest,
} from "../../src/browser/claude-desktop/file-bridge.js";
import { CueLineError } from "../../src/core/errors.js";

const ROOT = "/bridge-recovery";

function bridgeWithClaim(
  phase: "claimed" | "action_started" | "action_completed" | "response_published",
) {
  const files = new Map<string, string>();
  const fs: FileBridgeFs = {
    async mkdir() {},
    async writeAtomic(path, contents) {
      files.set(path, contents);
      if (!path.includes("/requests/")) return;
      const request = JSON.parse(contents) as FileBridgeRequest;
      files.delete(path);
      files.set(
        `${ROOT}/inflight/${request.id}.json`,
        JSON.stringify({
          ...request,
          phase,
          updatedAt: "2026-08-09T00:00:00.000Z",
        }),
      );
    },
    async read(path) {
      return files.get(path);
    },
    async remove(path) {
      files.delete(path);
    },
  };
  let clock = 0;
  const tools = createFileBridgeTools({
    root: ROOT,
    fs,
    requestTimeoutMs: 10,
    claimedTimeoutMs: 10,
    pollIntervalMs: 0,
    now: () => clock,
    sleep: async () => {
      clock += 20;
    },
    newRequestId: () => "req-recovery",
  });
  return { files, tools };
}

test("a claimed read-only request times out without losing its inflight record", async () => {
  const { files, tools } = bridgeWithClaim("claimed");
  await assert.rejects(
    () => tools.readPage("tab-1"),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "HOST_BRIDGE_TIMEOUT" &&
      (error.details as { claimed?: boolean; phase?: string }).claimed === true &&
      (error.details as { phase?: string }).phase === "claimed",
  );
  assert.ok(files.has(`${ROOT}/inflight/req-recovery.json`));
  assert.equal(files.has(`${ROOT}/requests/req-recovery.json`), false);
});

test("a completed side-effect action with a lost response reports unknown outcome", async () => {
  const { files, tools } = bridgeWithClaim("action_completed");
  await assert.rejects(
    () => tools.clickRef("tab-1", "ref-send"),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "HOST_BRIDGE_ACTION_OUTCOME_UNKNOWN" &&
      (error.details as { method?: string; phase?: string }).method === "clickRef" &&
      (error.details as { phase?: string }).phase === "action_completed",
  );
  assert.ok(files.has(`${ROOT}/inflight/req-recovery.json`));
});
