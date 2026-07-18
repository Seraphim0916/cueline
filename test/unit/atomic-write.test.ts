import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalJson } from "../../src/core/ids.js";
import { atomicCreateJson, atomicWriteJson } from "../../src/state/atomic-write.js";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "cueline-atomic-"));
}

async function assertNoTemporaryLeftovers(directory: string): Promise<void> {
  const entries = await readdir(directory);
  assert.deepEqual(
    entries.filter((name) => name.endsWith(".tmp")),
    [],
    `a durable write left a temporary behind: ${entries.join(", ")}`,
  );
}

test("atomicWriteJson writes canonical JSON with a trailing newline and owner-only permissions", async () => {
  const directory = await tempDir();
  const target = path.join(directory, "record.json");
  const value = { b: 2, a: 1, nested: { y: 2, x: 1 } };

  await atomicWriteJson(target, value);

  assert.equal(await readFile(target, "utf8"), `${canonicalJson(value)}\n`);
  assert.equal((await stat(target)).mode & 0o077, 0, "durable file must not be group/other accessible");
  await assertNoTemporaryLeftovers(directory);
});

test("atomicWriteJson atomically replaces an existing target and leaves no temporary behind", async () => {
  const directory = await tempDir();
  const target = path.join(directory, "record.json");

  await atomicWriteJson(target, { v: 1 });
  await atomicWriteJson(target, { v: 2 });

  assert.equal(await readFile(target, "utf8"), `${canonicalJson({ v: 2 })}\n`);
  await assertNoTemporaryLeftovers(directory);
});

test("atomicCreateJson creates an immutable record once and reports itself the winner", async () => {
  const directory = await tempDir();
  const target = path.join(directory, "terminal.json");

  const created = await atomicCreateJson(target, { outcome: "done" });

  assert.equal(created, true);
  assert.equal(await readFile(target, "utf8"), `${canonicalJson({ outcome: "done" })}\n`);
  assert.equal((await stat(target)).mode & 0o077, 0);
  await assertNoTemporaryLeftovers(directory);
});

test("atomicCreateJson refuses to overwrite an existing target and preserves its content", async () => {
  const directory = await tempDir();
  const target = path.join(directory, "terminal.json");

  await atomicCreateJson(target, { outcome: "first" });
  const second = await atomicCreateJson(target, { outcome: "second" });

  assert.equal(second, false);
  // This is the immutability guarantee terminal job records rely on: a losing
  // creator must never rewrite the record the winner already committed.
  assert.equal(await readFile(target, "utf8"), `${canonicalJson({ outcome: "first" })}\n`);
  await assertNoTemporaryLeftovers(directory);
});

test("concurrent atomicCreateJson yields exactly one winner and one durable record", async () => {
  const directory = await tempDir();
  const target = path.join(directory, "terminal.json");

  const results = await Promise.all(
    Array.from({ length: 8 }, (_unused, index) => atomicCreateJson(target, { creator: index })),
  );

  const winners = results.filter((won) => won === true);
  assert.equal(winners.length, 1, "the hard-link race must have a single winner");
  const winnerIndex = results.indexOf(true);
  assert.equal(await readFile(target, "utf8"), `${canonicalJson({ creator: winnerIndex })}\n`);
  await assertNoTemporaryLeftovers(directory);
});

test("atomicWriteJson rejects a non-serializable value without creating a target or leaking a temporary", async () => {
  const directory = await tempDir();
  const target = path.join(directory, "record.json");

  // canonicalJson throws only after the temporary has been opened, which drives
  // the write-failure cleanup path: the temp must be unlinked and no partially
  // written target may appear.
  await assert.rejects(atomicWriteJson(target, { bad: 1n }), /CANONICAL_JSON_UNSUPPORTED/);

  await assert.rejects(
    readFile(target, "utf8"),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  await assertNoTemporaryLeftovers(directory);
});

test("a failed atomicWriteJson replacement preserves the previous durable value", async () => {
  const directory = await tempDir();
  const target = path.join(directory, "record.json");
  await atomicWriteJson(target, { v: 1 });

  await assert.rejects(atomicWriteJson(target, { bad: 1n }), /CANONICAL_JSON_UNSUPPORTED/);

  // The rename never ran, so the previously committed value is left intact — a
  // failed replace can never destroy the durable record it was replacing.
  assert.equal(await readFile(target, "utf8"), `${canonicalJson({ v: 1 })}\n`);
  await assertNoTemporaryLeftovers(directory);
});

test("atomicCreateJson rejects a non-serializable value and cleans up its temporary", async () => {
  const directory = await tempDir();
  const target = path.join(directory, "terminal.json");

  await assert.rejects(atomicCreateJson(target, { bad: 1n }), /CANONICAL_JSON_UNSUPPORTED/);

  await assert.rejects(
    readFile(target, "utf8"),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  await assertNoTemporaryLeftovers(directory);
});

test("atomicWriteJson and atomicCreateJson materialize a missing private parent directory on demand", async () => {
  const directory = await tempDir();
  const nestedWrite = path.join(directory, "created-by-write", "record.json");
  const nestedCreate = path.join(directory, "created-by-create", "terminal.json");

  await atomicWriteJson(nestedWrite, { v: 1 });
  const created = await atomicCreateJson(nestedCreate, { v: 2 });

  assert.equal(created, true);
  assert.equal(await readFile(nestedWrite, "utf8"), `${canonicalJson({ v: 1 })}\n`);
  assert.equal(await readFile(nestedCreate, "utf8"), `${canonicalJson({ v: 2 })}\n`);
  // A directory conjured to hold durable state must itself be owner-only.
  assert.equal((await stat(path.dirname(nestedWrite))).mode & 0o077, 0);
  await assertNoTemporaryLeftovers(path.dirname(nestedWrite));
});
