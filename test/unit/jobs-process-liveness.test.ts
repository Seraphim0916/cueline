import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { pathToFileURL } from "node:url";

export function processIsAlive(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  readStat: (path: string, encoding: "utf8") => string = readFileSync,
  kill: (pid: number, signal: 0) => unknown = process.kill,
): boolean {
  if (platform === "linux") {
    try {
      const stat = readStat(`/proc/${pid}/stat`, "utf8");
      // comm may contain ") ", so the state follows the last ")".
      const state = stat[stat.lastIndexOf(")") + 2];
      return state !== "Z" && state !== "X";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH") return false;
      throw error;
    }
  }

  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

// Keep the helper and its regression tests in one test-only file without
// registering unit tests when the integration suite imports the helper.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
}
