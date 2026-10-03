import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CueLineError } from "../../core/errors.js";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function acquireClaudeDesktopLaneLock(
  root: string,
  options: { pid?: number; isAlive?: (pid: number) => boolean } = {},
): Promise<{ release(): Promise<void> }> {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? isProcessAlive;
  const lockPath = join(root, "lane.lock");
  const startedAt = new Date().toISOString();
  const contents = JSON.stringify({ pid, startedAt });
  await mkdir(root, { recursive: true });
  for (;;) {
    try {
      await writeFile(lockPath, contents, { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let existingPid: unknown;
    try {
      existingPid = (JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown }).pid;
    } catch {}
    if (typeof existingPid === "number" && Number.isSafeInteger(existingPid) && existingPid > 0 && isAlive(existingPid)) {
      throw new CueLineError("CLAUDE_DESKTOP_LANE_LOCKED", "A Claude Desktop lane daemon is already running.", {
        details: { pid: existingPid },
      });
    }
    await rm(lockPath, { force: true });
  }
  return {
    async release() {
      let current: { pid?: number; startedAt?: string };
      try {
        current = JSON.parse(await readFile(lockPath, "utf8")) as typeof current;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return;
        throw error;
      }
      if (current?.pid === pid && current.startedAt === startedAt) await rm(lockPath, { force: true });
    },
  };
}
