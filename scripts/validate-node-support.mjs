#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_NODE_MAJORS = [22, 24, 26];
const README_FILES = [
  "README.md",
  "README.zh-TW.md",
  "README.zh-CN.md",
  "README.ja.md",
  "README.ko.md",
];

function parseArgs(args) {
  let root = fileURLToPath(new URL("..", import.meta.url));
  let json = false;
  let rootSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--json" && !json) {
      json = true;
    } else if (
      args[index] === "--root" &&
      !rootSeen &&
      typeof args[index + 1] === "string"
    ) {
      root = path.resolve(args[index + 1]);
      rootSeen = true;
      index += 1;
    } else {
      throw new Error("usage: node scripts/validate-node-support.mjs [--root <path>] [--json]");
    }
  }
  return { root, json };
}

function sameNumbers(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function validateNodeSupport(root) {
  const findings = [];
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const engine = manifest.engines?.node ?? null;
  if (engine !== ">=22") {
    findings.push({
      code: "ENGINE_REQUIREMENT_MISMATCH",
      file: "package.json",
      message: "engines.node must remain >=22.",
    });
  }

  const workflow = await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const nodeMatrix = /node:\s*\[([^\]]+)\]/.exec(workflow)?.[1]
    ?.split(",")
    .map((value) => Number(value.trim())) ?? [];
  if (!sameNumbers(nodeMatrix, EXPECTED_NODE_MAJORS)) {
    findings.push({
      code: "CI_NODE_MATRIX_MISMATCH",
      file: ".github/workflows/ci.yml",
      message: "CI Node matrix must be exactly 22, 24, 26.",
    });
  }
  const osMatrix = /os:\s*\[([^\]]+)\]/.exec(workflow)?.[1]
    ?.split(",")
    .map((value) => value.trim()) ?? [];
  if (!sameNumbers(osMatrix, ["ubuntu-latest", "macos-latest"])) {
    findings.push({
      code: "CI_OS_MATRIX_MISMATCH",
      file: ".github/workflows/ci.yml",
      message: "CI OS matrix must cover Ubuntu and macOS.",
    });
  }

  for (const file of README_FILES) {
    const content = await readFile(path.join(root, file), "utf8");
    if (!/CI[^\n]*Node[^\n]*22[^\n]*24[^\n]*26/.test(content)) {
      findings.push({
        code: "README_NODE_MATRIX_STALE",
        file,
        message: "README CI support line must name Node 22, 24, and 26.",
      });
    }
  }

  const compatibility = await readFile(path.join(root, "docs/compatibility.md"), "utf8");
  if (!/Node\.js 22\+ ESM[^\n]*CI: 22, 24, 26/.test(compatibility)) {
    findings.push({
      code: "COMPATIBILITY_NODE_MATRIX_STALE",
      file: "docs/compatibility.md",
      message: "Compatibility matrix must name the tested Node majors.",
    });
  }

  return {
    schema: "cueline-node-support-validation/1",
    status: findings.length === 0 ? "passed" : "failed",
    engine,
    ciNodeMajors: nodeMatrix,
    ciOperatingSystems: osMatrix,
    currentNode: process.versions.node,
    findings,
  };
}

try {
  const options = parseArgs(process.argv.slice(2));
  const report = await validateNodeSupport(options.root);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(`Node support contract ${report.status}: ${report.ciNodeMajors.join(", ")}`);
  process.exitCode = report.status === "passed" ? 0 : 1;
} catch (error) {
  console.error(
    `Node support validation failed: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
}
