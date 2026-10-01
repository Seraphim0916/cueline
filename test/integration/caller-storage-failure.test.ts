import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

for (const action of ["claim", "start"] as const) {
  for (const boundary of ["before_event", "after_event", "status_rename", "snapshot_rename"] as const) {
    test(`${action} recovers safely from injected ${boundary} storage failure`, async () => {
      const home = await mkdtemp(path.join(tmpdir(), "cueline-storage-failure-"));
      try {
        const child = spawnSync(process.execPath, [fileURLToPath(new URL("../fixtures/caller-storage-failure-child.js", import.meta.url)),
          home, action, boundary], { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" });
        assert.equal(child.error, undefined, child.stderr);
        assert.equal(child.status, 0, child.stderr);
        const result = JSON.parse(child.stdout.trim());
        assert.equal(result.action, action);
        assert.equal(result.boundary, boundary);
        assert.equal(result.injected, 1);
        assert.equal(result.claimEvents, 1);
        assert.equal(result.startEvents, 1);
        assert.equal(result.fakeExecutions, 1);
        // State/status snapshots are disposable views. A failed post-event
        // commit/report or running-status rename may leave pending bytes while
        // authoritative replay is running.
        assert.equal(result.persistedStatus, action === "start" && (boundary === "after_event" || boundary === "status_rename") ? "pending" : "running");
      } finally { await rm(home, { recursive: true, force: true }); }
    });
  }
}
