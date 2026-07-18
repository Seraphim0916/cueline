import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { executableAvailability, findExecutable } from "../../src/router/availability.js";
import type { RouteCandidate } from "../../src/router/types.js";

async function dirWithExecutable(name: string): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "cueline-avail-"));
  const file = path.join(dir, name);
  await writeFile(file, "#!/bin/sh\ntrue\n", "utf8");
  await chmod(file, 0o755);
  return { dir, file };
}

test("findExecutable returns undefined for a blank command", () => {
  assert.equal(findExecutable("", { PATH: "/usr/bin" }), undefined);
  assert.equal(findExecutable("   ", { PATH: "/usr/bin" }), undefined);
});

test("findExecutable resolves a bare command through PATH and rejects a miss", async () => {
  const { dir, file } = await dirWithExecutable("myworker");
  assert.equal(findExecutable("myworker", { PATH: dir }), file);
  assert.equal(findExecutable("myworker", { PATH: path.join(dir, "nope") }), undefined);
  assert.equal(findExecutable("myworker", { PATH: "" }), undefined);
});

test("findExecutable resolves a path-containing command against the given cwd", async () => {
  const { dir, file } = await dirWithExecutable("runner.sh");
  assert.equal(findExecutable("./runner.sh", { PATH: "" }, dir), file);
  assert.equal(findExecutable(file, { PATH: "" }), file);
  assert.equal(findExecutable("./missing.sh", { PATH: "" }, dir), undefined);
});

test("findExecutable rejects a non-executable file on POSIX", async () => {
  if (process.platform === "win32") return;
  const dir = await mkdtemp(path.join(tmpdir(), "cueline-avail-"));
  const file = path.join(dir, "not-exec");
  await writeFile(file, "plain", "utf8");
  await chmod(file, 0o644);
  assert.equal(findExecutable("not-exec", { PATH: dir }), undefined);
});

test("executableAvailability reports availability and caches per executable", async () => {
  const { dir } = await dirWithExecutable("prov");
  const checker = executableAvailability({ PATH: dir });
  const available: RouteCandidate = { id: "a", argv: ["prov", "{task}"], task_input: "argv" };
  const missing: RouteCandidate = { id: "b", argv: ["absent-cmd"] };
  assert.equal(checker.isAvailable(available, "default"), true);
  assert.equal(checker.isAvailable(available, "default"), true); // cached hit, same result
  assert.equal(checker.isAvailable(missing, "default"), false);
  assert.equal(checker.isAvailable(missing, "default"), false);
});

test("executableAvailability treats a candidate with no executable as unavailable", () => {
  const checker = executableAvailability({ PATH: "/usr/bin" });
  assert.equal(checker.isAvailable({ id: "x", argv: [] } as RouteCandidate, "default"), false);
});
