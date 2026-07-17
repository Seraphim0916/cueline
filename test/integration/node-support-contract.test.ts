import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const script = path.join(root, "scripts/validate-node-support.mjs");
const fixtureFiles = [
  "package.json",
  ".github/workflows/ci.yml",
  "README.md",
  "README.zh-TW.md",
  "README.zh-CN.md",
  "README.ja.md",
  "README.ko.md",
  "docs/compatibility.md",
];

interface ValidationReport {
  status: "passed" | "failed";
  ciNodeMajors: number[];
  currentNode: string;
  findings: Array<{ code: string; file: string }>;
}

function invoke(targetRoot: string): { status: number | null; report: ValidationReport } {
  const result = spawnSync(process.execPath, [script, "--root", targetRoot, "--json"], {
    encoding: "utf8",
  });
  return {
    status: result.status,
    report: JSON.parse(String(result.stdout)) as ValidationReport,
  };
}

async function fixture(): Promise<string> {
  const target = await mkdtemp(path.join(tmpdir(), "cueline-node-support-"));
  for (const file of fixtureFiles) {
    const destination = path.join(target, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(path.join(root, file)));
  }
  return target;
}

test("repository declares and tests Node 22, 24, and 26 consistently", () => {
  const result = invoke(root);

  assert.equal(result.status, 0);
  assert.equal(result.report.status, "passed");
  assert.deepEqual(result.report.ciNodeMajors, [22, 24, 26]);
  assert.equal(result.report.currentNode, process.versions.node);
});

test("contract fails when CI omits Node 26", async () => {
  const target = await fixture();
  const workflow = path.join(target, ".github/workflows/ci.yml");
  await writeFile(workflow, (await readFile(workflow, "utf8")).replace("[22, 24, 26]", "[22, 24]"));

  const result = invoke(target);
  assert.equal(result.status, 1);
  assert.equal(
    result.report.findings.some((finding) => finding.code === "CI_NODE_MATRIX_MISMATCH"),
    true,
  );
});

test("contract fails when one README is stale", async () => {
  const target = await fixture();
  const readme = path.join(target, "README.zh-TW.md");
  await writeFile(readme, (await readFile(readme, "utf8")).replace("Node 22、24、26", "Node 22、24"));

  const result = invoke(target);
  assert.equal(result.status, 1);
  const stale = result.report.findings.filter(
    (finding) => finding.code === "README_NODE_MATRIX_STALE",
  );
  assert.equal(stale.length, 1);
  assert.equal(stale[0]?.file, "README.zh-TW.md");
});

test("contract fails when package engines drift", async () => {
  const target = await fixture();
  const manifestPath = path.join(target, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    engines: { node: string };
  };
  manifest.engines.node = ">=24";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const result = invoke(target);
  assert.equal(result.status, 1);
  assert.equal(result.report.findings[0]?.code, "ENGINE_REQUIREMENT_MISMATCH");
});
