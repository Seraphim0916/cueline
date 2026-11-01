import assert from "node:assert/strict";
import test from "node:test";
import { assertProcfsReadable, processIsAlive } from "../support/process-liveness.js";

const errno = (code: string) => Object.assign(new Error(code), { code });
const noKill = () => assert.fail("Linux must use only the stat read");

test("jobs liveness stays false when a zombie is reaped between checks", () => {
  let reads = 0;
  const readStat = (path: string, encoding: "utf8") => {
    assert.equal(path, "/proc/123/stat");
    assert.equal(encoding, "utf8");
    reads += 1;
    if (reads === 1) return "123 (child) Z 1";
    throw errno("ENOENT");
  };
  assert.equal(processIsAlive(123, "linux", readStat, noKill), false);
  assert.equal(processIsAlive(123, "linux", readStat, noKill), false);
  assert.equal(reads, 2);
});

test("jobs liveness distinguishes Linux running and dead states", () => {
  for (const state of ["S", "R", "Z", "X"]) {
    assert.equal(
      processIsAlive(123, "linux", () => `123 (child ) name) ${state} 1`, noKill),
      state === "S" || state === "R",
    );
  }
});

test("jobs liveness only swallows Linux missing-process errors", () => {
  for (const code of ["ENOENT", "ESRCH", "EACCES"]) {
    const error = errno(code);
    const check = () => processIsAlive(123, "linux", () => { throw error; }, noKill);
    if (code === "EACCES") assert.throws(check, (caught) => caught === error);
    else assert.equal(check(), false);
  }
});

test("jobs liveness elsewhere uses signal zero and only swallows ESRCH", () => {
  const noRead = () => assert.fail("Non-Linux must not read procfs");
  assert.equal(processIsAlive(123, "darwin", noRead, (pid, signal) => {
    assert.equal(pid, 123);
    assert.equal(signal, 0);
  }), true);
  for (const code of ["ESRCH", "EACCES", "EPERM", "ENOENT"]) {
    const error = errno(code);
    const check = () => processIsAlive(123, "darwin", noRead, () => { throw error; });
    if (code === "ESRCH") assert.equal(check(), false);
    else assert.throws(check, (caught) => caught === error);
  }
});

test("procfs preflight fails explicitly when Linux cannot read /proc/self/stat", () => {
  for (const code of ["ENOENT", "EACCES"]) {
    const error = errno(code);
    assert.throws(
      () => assertProcfsReadable("linux", (path) => {
        assert.equal(path, "/proc/self/stat");
        throw error;
      }),
      (caught) => {
        assert.match((caught as Error).message, /\/proc\/self\/stat is not readable/);
        assert.equal((caught as Error).cause, error);
        return true;
      },
    );
  }
});

test("procfs preflight accepts a readable Linux stat and skips other platforms", () => {
  let reads = 0;
  assertProcfsReadable("linux", (path, encoding) => {
    assert.equal(path, "/proc/self/stat");
    assert.equal(encoding, "utf8");
    reads += 1;
    return "1 (node) R 0";
  });
  assert.equal(reads, 1);
  assertProcfsReadable("darwin", () => assert.fail("Non-Linux must not read procfs"));
});
