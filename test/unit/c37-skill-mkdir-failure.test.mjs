import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";

import { installSkill } from "../../dist/src/cli/skill-links.js";

for (const code of ["ENOSPC", "EACCES"]) {
  test(`install stops before linking or the next target when mkdir fails with ${code}`, async (t) => {
    // These paths are only passed to mocks; no directories are created.
    const home = path.resolve("c37-mocked-home");
    const environment = {
      HOME: home,
      CODEX_HOME: path.join(home, ".codex"),
      CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    };
    const targets = [
      path.join(environment.CODEX_HOME, "skills", "cueline"),
      path.join(environment.CLAUDE_CONFIG_DIR, "skills", "cueline-host"),
    ];
    const failure = Object.assign(new Error(`${code}: mkdir failed`), { code });

    try {
      const accessMock = t.mock.method(fs, "access", async () => undefined);
      const lstatMock = t.mock.method(fs, "lstat", async () => {
        throw Object.assign(new Error("ENOENT: missing target"), { code: "ENOENT" });
      });
      const mkdirMock = t.mock.method(fs, "mkdir", async () => {
        throw failure;
      });
      const symlinkMock = t.mock.method(fs, "symlink", async () => undefined);
      const unlinkMock = t.mock.method(fs, "unlink", async () => undefined);
      t.mock.method(fs, "readlink", async () => {
        assert.fail("readlink must not run for a missing target");
      });
      syncBuiltinESMExports();

      await assert.rejects(installSkill(environment), (error) => {
        assert.strictEqual(error, failure);
        assert.equal(error.code, code);
        return true;
      });
      assert.equal(accessMock.mock.callCount(), 2);
      assert.deepEqual(
        [...new Set(lstatMock.mock.calls.map(({ arguments: args }) => args[0]))],
        targets,
      );
      assert.equal(mkdirMock.mock.callCount(), 1);
      assert.deepEqual(mkdirMock.mock.calls[0].arguments, [
        path.dirname(targets[0]),
        { recursive: true },
      ]);
      assert.equal(symlinkMock.mock.callCount(), 0);
      assert.equal(unlinkMock.mock.callCount(), 0);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
}
