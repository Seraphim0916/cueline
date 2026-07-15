import { randomUUID } from "node:crypto";
import { link, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { canonicalJson } from "../core/ids.js";
import { runtimePidTag, runtimePlatform } from "../core/runtime.js";

async function syncDirectory(directory: string): Promise<void> {
  if (runtimePlatform() === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function atomicWriteJson(target: string, value: unknown): Promise<void> {
  const directory = path.dirname(target);
  const created = await mkdir(directory, { recursive: true });
  if (created !== undefined) {
    await syncDirectory(path.dirname(created));
  }
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${runtimePidTag()}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${canonicalJson(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    await syncDirectory(directory);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/**
 * Durably creates an immutable JSON file without replacing an existing value.
 * A fully synced temporary is hard-linked into place so readers can never see
 * a partially written winner when multiple processes race to create it.
 */
export async function atomicCreateJson(target: string, value: unknown): Promise<boolean> {
  const directory = path.dirname(target);
  const created = await mkdir(directory, { recursive: true });
  if (created !== undefined) {
    await syncDirectory(path.dirname(created));
  }
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${runtimePidTag()}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${canonicalJson(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, target);
    } catch (error) {
      if (isAlreadyExists(error)) return false;
      throw error;
    }
    await syncDirectory(directory);
    return true;
  } finally {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await unlink(temporary).catch(() => undefined);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
