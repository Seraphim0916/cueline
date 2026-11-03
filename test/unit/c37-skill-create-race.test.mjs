import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";

import { installSkill } from "../../dist/src/cli/skill-links.js";

test("install preserves a competing path created after preflight and stops on EEXIST", async (t) => {
  // All filesystem operations below are mocked; these paths are never created.
  const home = path.resolve("virtual-c37-home");
  const environment = {
    HOME: home,
    CODEX_HOME: path.join(home, ".codex"),
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
  };
  const firstTarget = path.join(environment.CODEX_HOME, "skills", "cueline");
  const laterTarget = path.join(environment.CLAUDE_CONFIG_DIR, "skills", "cueline-host");
  const checkedTargets = new Set();
  const failure = Object.assign(new Error("EEXIST: competing path appeared after preflight"), {
    code: "EEXIST",
  });
  const mocks = [];
  const mock = (name, implementation) => {
    const replacement = t.mock.method(fs, name, implementation);
    mocks.push(replacement);
    return replacement;
  };

  try {
    const access = mock("access", async (candidate) => {
      assert.equal(path.basename(candidate), "SKILL.md");
    });
    mock("lstat", async (candidate) => {
      assert.ok(candidate === firstTarget || candidate === laterTarget);
      checkedTargets.add(candidate);
      throw Object.assign(new Error("ENOENT: absent during preflight"), { code: "ENOENT" });
    });
    const readlink = mock("readlink", async () => {
      assert.fail("an absent target must not be read");
    });
    const mkdir = mock("mkdir", async () => undefined);
    const symlink = mock("symlink", async (_source, target) => {
      assert.equal(access.mock.callCount(), 2);
      assert.deepEqual(checkedTargets, new Set([firstTarget, laterTarget]));
      assert.equal(target, firstTarget);
      // A competing creator wins only after both targets passed preflight.
      throw failure;
    });
    const unlink = mock("unlink", async () => undefined);
    const rm = mock("rm", async () => undefined);
    const rename = mock("rename", async () => undefined);
    syncBuiltinESMExports();

    await assert.rejects(installSkill(environment), (error) => {
      assert.strictEqual(error, failure);
      assert.equal(error.code, "EEXIST");
      return true;
    });
    assert.equal(unlink.mock.callCount(), 0);
    assert.equal(rm.mock.callCount(), 0);
    assert.equal(rename.mock.callCount(), 0);
    assert.equal(readlink.mock.callCount(), 0);
    assert.equal(symlink.mock.callCount(), 1);
    assert.deepEqual(
      symlink.mock.calls.map(({ arguments: args }) => args[1]),
      [firstTarget],
    );
    assert.deepEqual(
      mkdir.mock.calls.map(({ arguments: args }) => args),
      [[path.dirname(firstTarget), { recursive: true }]],
    );
  } finally {
    for (const replacement of mocks.reverse()) replacement.mock.restore();
    syncBuiltinESMExports();
  }
});
