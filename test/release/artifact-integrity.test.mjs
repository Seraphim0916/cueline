import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareOutputDirectory, sha256File, verifyArtifactManifest } from "../../scripts/artifact-integrity.mjs";

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "cueline-artifact-"));
  const filename = "cueline-1.0.0.tgz";
  const artifact = path.join(directory, filename);
  await writeFile(artifact, "known artifact bytes");
  const sha256 = await sha256File(artifact);
  await writeFile(`${artifact}.sha256`, `${sha256}  ${filename}\n`);
  const manifestPath = `${artifact}.manifest.json`;
  await writeFile(manifestPath, JSON.stringify({
    schema: "cueline-artifact-manifest/1",
    package: { name: "cueline", version: "1.0.0" },
    artifact: { filename, sha256, size: 20, unpackedSize: 20, fileCount: 1 },
    files: [{ path: "package.json", size: 20, mode: 420 }],
  }));
  return { directory, artifact, manifestPath };
}

test("verifies an exact artifact, checksum, and manifest", async () => {
  const { manifestPath } = await fixture();
  assert.equal((await verifyArtifactManifest(manifestPath)).status, "ok");
});

test("detects artifact tampering", async () => {
  const { artifact, manifestPath } = await fixture();
  await writeFile(artifact, "tampered artifact bytes");
  await assert.rejects(verifyArtifactManifest(manifestPath), /sha256 mismatch/);
});

test("rejects manifest path traversal", async () => {
  const { directory, manifestPath } = await fixture();
  await writeFile(manifestPath, JSON.stringify({
    schema: "cueline-artifact-manifest/1",
    artifact: { filename: "../escape.tgz", sha256: "0".repeat(64) },
  }));
  await assert.rejects(verifyArtifactManifest(manifestPath), /unsafe artifact filename/);
  assert.equal(path.dirname(manifestPath), directory);
});

test("rejects a symlinked output directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cueline-artifact-root-"));
  const outside = await mkdtemp(path.join(tmpdir(), "cueline-artifact-outside-"));
  await mkdir(path.join(root, "nested"));
  await symlink(outside, path.join(root, "nested", "release"));
  await assert.rejects(prepareOutputDirectory(root, "nested/release"), /symbolic link/);
});

test("rejects output path escape before creating it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cueline-artifact-root-"));
  await assert.rejects(prepareOutputDirectory(root, "../escape"), /child directory/);
});
