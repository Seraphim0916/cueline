import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const REQUIRED_FILES = [
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "bin/cueline",
  "config/routing.default.json",
  "dist/src/api.d.ts",
  "dist/src/api.js",
  "skills/cueline/SKILL.md",
];
const FORBIDDEN_PACKAGE_PATH = /(^|\/)(?:\.env(?:\..*)?|events\.jsonl|runtime\.json|snapshot\.json|cancel\.json|[^/]+\.(?:pem|key|p12))$/;

function finding(code, surface, message) {
  return { code, surface, message };
}

export function evaluateReleaseCandidate(input) {
  const findings = [];
  const version = input.packageJson.version;
  if (typeof version !== "string" || !SEMVER.test(version)) {
    findings.push(finding("VERSION_INVALID", "package", "package version must be strict semver"));
  }
  if (input.packageJson.private !== false) {
    findings.push(finding("PACKAGE_NOT_PUBLIC", "package", "package must explicitly set private to false"));
  }
  for (const [surface, candidate] of [
    ["package-lock", input.packageLockVersion],
    ["codex-plugin", input.codexPluginVersion],
    ["claude-plugin", input.claudePluginVersion],
  ]) {
    if (candidate !== version) {
      findings.push(finding("VERSION_MISMATCH", surface, `${surface} version must match package.json`));
    }
  }
  if (typeof version === "string" && !input.changelog.includes(`## ${version} - `)) {
    findings.push(finding("CHANGELOG_ENTRY_MISSING", "changelog", "current package version needs a dated changelog heading"));
  }
  if (!input.allowDirty && input.gitStatus.trim() !== "") {
    findings.push(finding("GIT_DIRTY", "git", "release check requires a clean worktree"));
  }
  const packaged = new Set(input.packFiles);
  for (const required of REQUIRED_FILES) {
    if (!packaged.has(required)) {
      findings.push(finding("PACKAGE_FILE_MISSING", "package", `required package file is missing: ${required}`));
    }
  }
  for (const file of packaged) {
    if (FORBIDDEN_PACKAGE_PATH.test(file) || file.startsWith("node_modules/") || file.startsWith(".git/")) {
      findings.push(finding("PACKAGE_FILE_FORBIDDEN", "package", `forbidden package file: ${file}`));
    }
  }
  return findings;
}

async function readJson(root, relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

export async function collectReleaseReadiness(root, options = {}) {
  const [packageJson, packageLock, codexPlugin, claudePlugin, changelog, git, pack] = await Promise.all([
    readJson(root, "package.json"),
    readJson(root, "package-lock.json"),
    readJson(root, ".codex-plugin/plugin.json"),
    readJson(root, ".claude-plugin/plugin.json"),
    readFile(path.join(root, "CHANGELOG.md"), "utf8"),
    execFile("git", ["status", "--porcelain"], { cwd: root }),
    execFile("npm", ["pack", "--dry-run", "--json"], { cwd: root, maxBuffer: 10 * 1024 * 1024 }),
  ]);
  const packReport = JSON.parse(pack.stdout)[0];
  const packFiles = Array.isArray(packReport?.files) ? packReport.files.map((entry) => entry.path) : [];
  const findings = evaluateReleaseCandidate({
    packageJson,
    packageLockVersion: packageLock?.packages?.[""]?.version,
    codexPluginVersion: codexPlugin.version,
    claudePluginVersion: claudePlugin.version,
    changelog,
    gitStatus: git.stdout,
    packFiles,
    allowDirty: options.allowDirty === true,
  });
  return {
    schema: "cueline-release-check/1",
    version: packageJson.version,
    status: findings.length === 0 ? "ok" : "blocked",
    package: {
      filename: packReport?.filename ?? null,
      files: packFiles.length,
      size: packReport?.size ?? null,
      unpackedSize: packReport?.unpackedSize ?? null,
    },
    findings,
  };
}

const invokedPath = process.argv[1] === undefined ? "" : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const allowed = new Set(["--allow-dirty"]);
  const unknown = process.argv.slice(2).filter((arg) => !allowed.has(arg));
  if (unknown.length > 0) {
    console.error(JSON.stringify({ schema: "cueline-release-check/1", status: "error", code: "USAGE", message: "usage: npm run release:check -- [--allow-dirty]" }));
    process.exitCode = 2;
  } else {
    const report = await collectReleaseReadiness(root, { allowDirty: process.argv.includes("--allow-dirty") });
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== "ok") process.exitCode = 1;
  }
}
