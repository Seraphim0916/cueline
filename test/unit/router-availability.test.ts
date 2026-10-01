import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

test("findExecutable rejects directories in direct relative and PATH configuration", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "cueline-avail-directory-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runner = path.join(dir, "runner");
  await mkdir(runner);
  assert.equal(findExecutable(runner, { PATH: "" }), undefined);
  assert.equal(findExecutable("./runner", { PATH: "" }, dir), undefined);
  assert.equal(findExecutable("runner", { PATH: dir }), undefined);
});

test("findExecutable skips a PATH directory match and finds the later executable", async (t) => {
  const first = await mkdtemp(path.join(tmpdir(), "cueline-avail-path-first-"));
  const second = await dirWithExecutable("worker");
  t.after(() => Promise.all([rm(first, { recursive: true, force: true }), rm(second.dir, { recursive: true, force: true })]));
  await mkdir(path.join(first, "worker"));
  assert.equal(findExecutable("worker", { PATH: [first, second.dir].join(path.delimiter) }), second.file);
});

test("findExecutable preserves ordinary symlinked executable wrappers", async (t) => {
  if (process.platform === "win32") { t.skip("Creating symlinks can require Windows developer privileges"); return; }
  const { dir, file } = await dirWithExecutable("wrapper");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const link = path.join(dir, "worker");
  await symlink(file, link);
  assert.equal(findExecutable(link, { PATH: "" }), link);
  assert.equal(findExecutable("worker", { PATH: dir }), link);
});

for (const owner of ["job", "coordinator"] as const) {
  test(`relative PATH entries resolve in the job cwd when the ${owner} owns the executable`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "cueline-avail-relative-path-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const coordinator = path.join(root, "coordinator");
    const job = path.join(root, "job");
    const fallback = path.join(root, "fallback");
    await Promise.all([coordinator, job].map((dir) => mkdir(path.join(dir, "tools"), { recursive: true })));
    await mkdir(fallback);
    const localWorker = path.join(owner === "job" ? job : coordinator, "tools", "worker");
    const fallbackWorker = path.join(fallback, "worker");
    for (const file of [localWorker, fallbackWorker]) {
      await writeFile(file, "executable fixture\n", "utf8");
      await chmod(file, 0o755);
    }

    const originalCwd = process.cwd();
    try {
      // All assertions are synchronous: never yield while the test changes cwd.
      process.chdir(coordinator);
      for (const relative of ["tools", `.${path.sep}tools`]) {
        assert.equal(findExecutable("worker", { PATH: relative }, job), owner === "job" ? localWorker : undefined);
        assert.equal(findExecutable("worker", { PATH: [relative, fallback].join(path.delimiter) }, job),
          owner === "job" ? localWorker : fallbackWorker);
      }
      // Preserve the existing policy that empty PATH entries are not searched.
      assert.equal(findExecutable("worker", { PATH: "" }, job), undefined);
      assert.equal(findExecutable("worker", { PATH: path.delimiter }, job), undefined);
    } finally {
      process.chdir(originalCwd);
    }
  });
}
