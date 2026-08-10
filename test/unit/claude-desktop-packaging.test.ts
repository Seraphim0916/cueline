import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

interface PackageManifest {
  bin?: Record<string, string>;
  files?: string[];
}

interface PackageLock {
  packages?: Record<string, PackageManifest>;
}

test("npm package exposes compiled Claude Desktop host binaries", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as PackageManifest;
  const lock = JSON.parse(await readFile("package-lock.json", "utf8")) as PackageLock;

  assert.equal(
    manifest.bin?.["cueline-claude-desktop-lane"],
    "bin/cueline-claude-desktop-lane",
  );
  assert.equal(
    manifest.bin?.["cueline-claude-desktop-mailbox"],
    "bin/cueline-claude-desktop-mailbox",
  );
  assert.ok(manifest.files?.includes("dist/scripts"));
  assert.deepEqual(lock.packages?.[""]?.bin, manifest.bin);

  for (const file of ["bin/cueline-claude-desktop-lane", "bin/cueline-claude-desktop-mailbox"]) {
    assert.match(await readFile(file, "utf8"), /^#!\/usr\/bin\/env node\n/);
    assert.equal((await stat(file)).mode & 0o777, 0o755);
  }

  await Promise.all([
    readFile("dist/scripts/claude-desktop-lane.js", "utf8"),
    readFile("dist/scripts/claude-desktop-mailbox.js", "utf8"),
  ]);
});
