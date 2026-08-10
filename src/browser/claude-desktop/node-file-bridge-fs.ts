import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

import type { FileBridgeFs } from "./file-bridge.js";

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
      const staging = `${path}.partial`;
      await writeFile(staging, contents, "utf8");
      await rename(staging, path);
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
  };
}
