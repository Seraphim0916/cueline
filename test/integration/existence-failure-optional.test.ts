import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The two existence checks left out of filesystem-existence-failure.test.ts: skill-links' pathExists and
// RunStore.createWithInitialEvent (including its existing-first-event recovery). Only ENOENT may mean
// "absent"; EACCES and EIO must surface and leave nothing written.
async function fixture(operation: string, code: string, site?: string) {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-existence-optional-"));
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL(
      "../fixtures/existence-failure-optional-child.js", import.meta.url)), home, operation, code,
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
  test(`skill install existence check: ${code}`, async () => {
    const out = await fixture("skill-install", code);
    if (code === "ENOENT") {
      assert.equal(out.errorCode, undefined);
      assert.match(out.message, /CueLine skill installed:/);
      assert.equal(out.linked, true);
    } else {
      assert.equal(out.errorCode, code);
      assert.equal(out.linked, false, "an unreadable target must not be replaced by a link");
    }
  });

  test(`skill uninstall existence check: ${code}`, async () => {
    const out = await fixture("skill-uninstall", code);
    if (code === "ENOENT") {
      assert.equal(out.errorCode, undefined);
      assert.match(out.message, /CueLine skill not installed:/);
    } else {
      assert.equal(out.errorCode, code, "an unreadable target must not be reported as not installed");
      assert.equal(out.message, undefined);
    }
    assert.equal(out.linked, false);
  });

  for (const site of ["marker", "segments", "recovery"]) {
    test(`store initial-event ${site} existence check: ${code}`, async () => {
      const out = await fixture("initial-event", code, site);
      assert.equal(out.site, site);
      if (code === "ENOENT") {
        assert.equal(out.created, true);
        assert.equal(out.errorCode, undefined);
        assert.ok(out.files.length > out.before.length, "absent path must allow creation");
      } else {
        assert.equal(out.created, false);
        assert.equal(out.errorCode, code);
        assert.deepEqual(out.files, out.before, "failed creation must not write any files");
        assert.equal(out.eventsUnchanged, true);
      }
    });
  }
}
