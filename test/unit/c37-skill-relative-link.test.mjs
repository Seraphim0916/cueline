import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { installSkill } from "../../dist/src/cli/skill-links.js";

const moduleURL = new URL("../../dist/src/cli/skill-links.js", import.meta.url);
const home = path.resolve("/__cueline_relative_link_test__");
const environment = {
  HOME: home,
  CODEX_HOME: path.join(home, ".codex"),
  CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
};
const links = [
  {
    source: fileURLToPath(new URL("../../../skills/cueline", moduleURL)),
    target: path.join(environment.CODEX_HOME, "skills", "cueline"),
  },
  {
    source: fileURLToPath(new URL("../../../skills/cueline-host", moduleURL)),
    target: path.join(environment.CLAUDE_CONFIG_DIR, "skills", "cueline-host"),
  },
];

function mockRelativeLinks(t, foreignTarget) {
  const destinations = new Map(links.map(({ source, target }) => {
    const destination = target === foreignTarget ? path.join(home, "foreign-skill") : source;
    const relative = path.relative(path.dirname(target), destination);
    assert.equal(path.isAbsolute(relative), false);
    assert.equal(path.resolve(path.dirname(target), relative), destination);
    return [target, relative];
  }));
  const mocks = {
    access: t.mock.method(fs, "access", async (candidate) => {
      assert.ok(links.some(({ source }) => candidate === path.join(source, "SKILL.md")));
    }),
    lstat: t.mock.method(fs, "lstat", async (candidate) => {
      assert.ok(destinations.has(candidate));
      return { isSymbolicLink: () => true };
    }),
    readlink: t.mock.method(fs, "readlink", async (candidate) => {
      assert.ok(destinations.has(candidate));
      return destinations.get(candidate);
    }),
    mkdir: t.mock.method(fs, "mkdir", async () => undefined),
    symlink: t.mock.method(fs, "symlink", async () => undefined),
    unlink: t.mock.method(fs, "unlink", async () => undefined),
  };
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  syncBuiltinESMExports();
  return mocks;
}

function assertNoWrites(mocks) {
  for (const method of ["mkdir", "symlink", "unlink"]) {
    assert.equal(mocks[method].mock.callCount(), 0, `${method} must not be called`);
  }
}

test("correct relative skill links are already installed on repeated installation", async (t) => {
  const mocks = mockRelativeLinks(t);
  const expected = links.map(({ target }) => `CueLine skill already installed: ${target}`).join("\n");

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    assert.equal(await installSkill(environment), expected);
    assert.equal(mocks.access.mock.callCount(), 2 * attempt);
    assert.equal(mocks.lstat.mock.callCount(), 2 * attempt);
    assert.equal(mocks.readlink.mock.callCount(), 2 * attempt);
    assertNoWrites(mocks);
  }
});

for (const [index, { target }] of links.entries()) {
  test(`foreign relative ${index === 0 ? "Codex" : "Claude"} skill link is protected`, async (t) => {
    const mocks = mockRelativeLinks(t, target);

    await assert.rejects(installSkill(environment), {
      message: `refusing to replace foreign path: ${target}`,
    });
    assert.equal(mocks.access.mock.callCount(), index + 1);
    assert.equal(mocks.readlink.mock.callCount(), index + 1);
    assertNoWrites(mocks);
  });
}
