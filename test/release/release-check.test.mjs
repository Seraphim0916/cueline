import assert from "node:assert/strict";
import test from "node:test";

import { evaluateReleaseCandidate } from "../../scripts/release-check.mjs";

const requiredFiles = [
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

function candidate(overrides = {}) {
  return {
    packageJson: { version: "1.0.0", private: false },
    packageLockVersion: "1.0.0",
    codexPluginVersion: "1.0.0",
    claudePluginVersion: "1.0.0",
    changelog: "# Changelog\n\n## 1.0.0 - 2026-07-17\n",
    gitStatus: "",
    packFiles: requiredFiles,
    allowDirty: false,
    ...overrides,
  };
}

test("accepts a clean internally consistent candidate", () => {
  assert.deepEqual(evaluateReleaseCandidate(candidate()), []);
});

test("blocks dirty trees, version drift, and missing changelog evidence", () => {
  const codes = evaluateReleaseCandidate(candidate({
    codexPluginVersion: "0.9.0",
    changelog: "# Changelog\n",
    gitStatus: " M package.json\n",
  })).map((item) => item.code);
  assert.deepEqual(codes, ["VERSION_MISMATCH", "CHANGELOG_ENTRY_MISSING", "GIT_DIRTY"]);
});

test("blocks missing required files and accidentally packaged state or keys", () => {
  const files = requiredFiles.filter((file) => file !== "dist/src/api.js");
  files.push("runs/run-1/events.jsonl", "secrets/signing.pem");
  const findings = evaluateReleaseCandidate(candidate({ packFiles: files }));
  assert.deepEqual(findings.map((item) => item.code), [
    "PACKAGE_FILE_MISSING",
    "PACKAGE_FILE_FORBIDDEN",
    "PACKAGE_FILE_FORBIDDEN",
  ]);
});

test("allow-dirty bypasses only the explicit worktree gate", () => {
  assert.deepEqual(evaluateReleaseCandidate(candidate({ gitStatus: " M package.json\n", allowDirty: true })), []);
});
