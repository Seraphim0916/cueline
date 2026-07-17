import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const README_FILES = [
  "README.md",
  "README.zh-TW.md",
  "README.zh-CN.md",
  "README.ja.md",
  "README.ko.md",
];

function collectVersions(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => match[1]);
}

function requireCurrentVersion(issues, file, label, versions, expected) {
  if (versions.length === 0) {
    issues.push(`${file}: missing ${label}`);
    return;
  }
  for (const version of versions) {
    if (version !== expected) {
      issues.push(`${file}: ${label} uses ${version}; expected ${expected}`);
    }
  }
}

export async function validateDocVersions(root) {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const expected = manifest.version;
  const issues = [];

  for (const file of README_FILES) {
    const text = await readFile(path.join(root, file), "utf8");
    requireCurrentVersion(
      issues,
      file,
      "npm install command",
      collectVersions(text, /npm install -g cueline@(\d+\.\d+\.\d+)/g),
      expected,
    );
    requireCurrentVersion(
      issues,
      file,
      "release tarball URL",
      collectVersions(text, /releases\/download\/v\d+\.\d+\.\d+\/cueline-(\d+\.\d+\.\d+)\.tgz/g),
      expected,
    );
    requireCurrentVersion(
      issues,
      file,
      "doctor output",
      collectVersions(text, /^CueLine (\d+\.\d+\.\d+)$/gm),
      expected,
    );
  }

  const compatibility = await readFile(path.join(root, "docs/compatibility.md"), "utf8");
  for (const pattern of [/v0\.\d+ status/, /^## Supported in v0\.\d+$/m, /^## Not supported in v0\.\d+$/m]) {
    if (pattern.test(compatibility)) {
      issues.push(`docs/compatibility.md: release-specific contract heading ${pattern}`);
    }
  }
  return issues;
}

const invokedPath = process.argv[1] === undefined ? "" : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const issues = await validateDocVersions(root);
  if (issues.length > 0) {
    for (const issue of issues) console.error(issue);
    process.exitCode = 1;
  } else {
    console.log(`Documentation versions match package ${manifest.version}`);
  }
}
