import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

async function fixture(operation: "prune" | "create", code: string, site?: string) {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-existence-failure-"));
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL(
      "../fixtures/filesystem-existence-failure-child.js", import.meta.url)), home, operation, code,
      ...(site ? [site] : [])], { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL",
      env: { ...process.env, CUELINE_HOME: home } });
    assert.equal(child.error, undefined, child.stderr);
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim());
    assert.equal(result.operation, operation);
    assert.equal(result.code, code);
    assert.equal(result.injected, 1, "must reach the targeted existence check");
    return result;
  } finally { await rm(home, { recursive: true, force: true }); }
}

for (const code of ["EACCES", "EIO", "ENOENT"]) {
  test(`runs prune existence check: ${code}`, async () => {
    const out = await fixture("prune", code);
    assert.equal(out.deleteAttempts, 1);
    assert.equal(out.result.eligibleRuns, 0); // This counter is for dry-run decisions only.
    assert.equal(out.result.removedJobRecords, 0);
    assert.equal(out.result.decisions.length, 1);
    const decision = out.result.decisions[0];
    assert.equal(decision.runId, "existence-failure");
    if (code === "ENOENT") {
      assert.equal(out.present, false);
      assert.equal(out.result.prunedRuns, 1);
      assert.equal(out.result.keptRuns, 0);
      assert.deepEqual(out.result.errors, []);
      assert.equal(decision.decision, "pruned");
    } else {
      assert.equal(out.present, true);
      assert.equal(out.unchanged, true, "no run file may be removed or changed");
      assert.equal(out.result.prunedRuns, 0);
      assert.equal(out.result.keptRuns, 1);
      assert.equal(out.result.errors.length, 1);
      assert.equal(out.result.errors[0].runId, "existence-failure");
      assert.match(out.result.errors[0].message, /injected deletion fence/);
      assert.equal(decision.decision, "kept");
      assert.equal(decision.reason, "delete_failed");
    }
  });
  for (const site of ["segments", "marker"]) {
    test(`store creation ${site} existence check: ${code}`, async () => {
      const out = await fixture("create", code, site);
      assert.equal(out.site, site);
      if (code === "ENOENT") {
        assert.equal(out.created, true);
        assert.equal(out.errorCode, undefined);
        assert.ok(out.files.length > 0, "absent path must allow creation");
      } else {
        assert.equal(out.created, false);
        assert.equal(out.errorCode, code);
        assert.deepEqual(out.files, [], "failed creation must not write any files");
      }
    });
  }
}
