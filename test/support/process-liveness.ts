import { readFileSync } from "node:fs";

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

// processIsAlive reads ENOENT as "process is gone", so without a mounted /proc
// every live process looks dead and "must be dead" assertions pass falsely.
export function assertProcfsReadable(
  platform: NodeJS.Platform = process.platform,
  readStat: (path: string, encoding: "utf8") => string = readFileSync,
): void {
  if (platform !== "linux") return;
  try {
    readStat("/proc/self/stat", "utf8");
  } catch (error) {
    throw new Error(
      `/proc/self/stat is not readable, so process liveness checks cannot be trusted: ${(error as Error).message}`,
      { cause: error },
    );
  }
}

// At load, not in one test: test:integration runs without the unit suite, and
// every importer depends on these answers.
assertProcfsReadable();
