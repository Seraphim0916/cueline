import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";

import { CueLineError } from "../core/errors.js";
import { runtimePlatform } from "../core/runtime.js";

/**
 * Creates or tightens one CueLine-owned state directory. Existing symlinks are
 * rejected so permission repair cannot be redirected outside the state tree.
 */
export async function ensurePrivateDirectory(directory: string): Promise<string | undefined> {
  const invalid = (cause?: unknown): CueLineError =>
    new CueLineError(
      "PRIVATE_STATE_DIRECTORY_INVALID",
      `CueLine private state path '${directory}' is not a real directory.`,
      cause === undefined ? {} : { cause },
    );
  const created = await mkdir(directory, { recursive: true, mode: 0o700 }).catch(
    (error: unknown) => {
      throw invalid(error);
    },
  );
  if (runtimePlatform() === "win32") {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw invalid();
    return created;
  }
  let handle;
  try {
    handle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    if (!(await handle.stat()).isDirectory()) throw invalid();
    await handle.chmod(0o700);
  } catch (error) {
    if (error instanceof CueLineError) throw error;
    throw invalid(error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return created;
}
