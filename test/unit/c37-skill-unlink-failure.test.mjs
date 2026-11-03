import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { uninstallSkill } from "../../dist/src/cli/skill-links.js";

// Resolve sources relative to the built module, just as uninstallSkill does.
const moduleUrl = new URL("../../dist/src/cli/skill-links.js", import.meta.url);
const codexSource = fileURLToPath(new URL("../../../skills/cueline", moduleUrl));
const claudeSource = fileURLToPath(new URL("../../../skills/cueline-host", moduleUrl));

for (const code of ["EIO", "EPERM"]) {
  test(`uninstall propagates ${code} from unlink without success or subsequent targets`, async (t) => {
    // These paths are only passed to mocks; no directories or links are created.
    const home = path.resolve("c37-virtual-home");
    const environment = {
      HOME: home,
      CODEX_HOME: path.join(home, ".codex"),
      CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    };
    const codexTarget = path.join(environment.CODEX_HOME, "skills", "cueline");
    const claudeTarget = path.join(environment.CLAUDE_CONFIG_DIR, "skills", "cueline-host");
    const failure = Object.assign(new Error(`${code}: unlink failed`), { code });
    const calls = [];
    const mocks = [];
    const returnedMessages = [];

    try {
      mocks.push(t.mock.method(fs, "lstat", async (candidate) => {
        calls.push(["lstat", candidate]);
        return { isSymbolicLink: () => true };
      }));
      mocks.push(t.mock.method(fs, "readlink", async (candidate) => {
        calls.push(["readlink", candidate]);
        return candidate === codexTarget ? codexSource : claudeSource;
      }));
      const unlinkMock = t.mock.method(fs, "unlink", async (candidate) => {
        calls.push(["unlink", candidate]);
        throw failure;
      });
      mocks.push(unlinkMock);
      syncBuiltinESMExports();

      await assert.rejects(
        uninstallSkill(environment, "all").then((message) => {
          returnedMessages.push(message);
          return message;
        }),
        (error) => {
          assert.strictEqual(error, failure);
          assert.equal(error.code, code);
          return true;
        },
      );
      assert.equal(unlinkMock.mock.callCount(), 1);
      assert.deepEqual(calls, [
        ["lstat", codexTarget],
        ["readlink", codexTarget],
        ["unlink", codexTarget],
      ]);
      assert.equal(calls.some(([, candidate]) => candidate === claudeTarget), false);
      assert.deepEqual(returnedMessages, []);
    } finally {
      for (const mock of mocks) mock.mock.restore();
      syncBuiltinESMExports();
    }
  });
}
