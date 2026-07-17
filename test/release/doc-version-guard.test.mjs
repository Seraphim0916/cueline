import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validateDocVersions } from "../../scripts/validate-doc-versions.mjs";

const readmes = ["README.md", "README.zh-TW.md", "README.zh-CN.md", "README.ja.md", "README.ko.md"];

async function fixture(version = "1.2.3") {
  const root = await mkdtemp(path.join(tmpdir(), "cueline-doc-version-"));
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version }));
  const body = [
    `npm install -g cueline@${version}`,
    `https://github.com/Seraphim0916/cueline/releases/download/v${version}/cueline-${version}.tgz`,
    `CueLine ${version}`,
    "Historical note: observability was added in 0.2.0.",
  ].join("\n");
  await Promise.all(readmes.map((file) => writeFile(path.join(root, file), body)));
  await writeFile(path.join(root, "docs/compatibility.md"), "# Compatibility\n\n## Supported contract\n\n## Not supported\n");
  return root;
}

test("accepts current actionable versions while allowing historical release notes", async () => {
  assert.deepEqual(await validateDocVersions(await fixture()), []);
});

test("rejects a stale install command", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "README.md"), [
    "npm install -g cueline@0.2.0",
    "https://github.com/Seraphim0916/cueline/releases/download/v1.2.3/cueline-1.2.3.tgz",
    "CueLine 1.2.3",
  ].join("\n"));
  assert.deepEqual(await validateDocVersions(root), [
    "README.md: npm install command uses 0.2.0; expected 1.2.3",
  ]);
});

test("rejects release-specific compatibility headings", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "docs/compatibility.md"), "# Compatibility\n\n## Supported in v0.1\n");
  assert.match((await validateDocVersions(root)).join("\n"), /release-specific contract heading/);
});
