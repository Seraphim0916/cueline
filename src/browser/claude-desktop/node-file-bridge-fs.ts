import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

import type { FileBridgeFs } from "./file-bridge.js";

// Shared by bridge instances in this process; this is not a cross-process lock.
const pendingWrites = new Map<string, Promise<void>>();

/**
 * Disk-backed bridge storage. Publishing goes through a temporary file and a
 * rename so the host agent never reads a half-written request, and vice versa.
 */
export function createNodeFileBridgeFs(): FileBridgeFs {
  return {
    async mkdir(directory) {
      await mkdir(directory, { recursive: true });
    },
    async writeAtomic(path, contents) {
      const previous = pendingWrites.get(path) ?? Promise.resolve();
      const operation = previous.then(async () => {
        const staging = `${path}.partial`;
        await writeFile(staging, contents, "utf8");
        await rename(staging, path);
      });
      const settled = operation.catch(() => {});
      pendingWrites.set(path, settled);
      try {
        await operation;
      } finally {
        if (pendingWrites.get(path) === settled) pendingWrites.delete(path);
      }
    },
    async read(path) {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    async remove(path) {
      await rm(path, { force: true });
    },
    async rename(source, destination) {
      await rename(source, destination);
    },
  };
}
