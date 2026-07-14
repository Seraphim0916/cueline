import { access, lstat, mkdir, readlink, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skillSource = fileURLToPath(new URL("../../../skills/cueline", import.meta.url));

function codexHome(environment: NodeJS.ProcessEnv): string {
  if (environment.CODEX_HOME) return path.resolve(environment.CODEX_HOME);
  const home = environment.HOME || homedir();
  return path.join(home, ".codex");
}

function skillTarget(environment: NodeJS.ProcessEnv): string {
  return path.join(codexHome(environment), "skills", "cueline");
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function linkMatches(target: string, source: string): Promise<boolean> {
  try {
    const details = await lstat(target);
    if (!details.isSymbolicLink()) return false;
    const linked = await readlink(target);
    return path.resolve(path.dirname(target), linked) === path.resolve(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function installSkill(environment: NodeJS.ProcessEnv): Promise<string> {
  const target = skillTarget(environment);
  await access(path.join(skillSource, "SKILL.md"));
  if (await linkMatches(target, skillSource)) {
    return `CueLine skill already installed: ${target}`;
  }
  if (await pathExists(target)) {
    throw new Error(`refusing to replace foreign path: ${target}`);
  }
  await mkdir(path.dirname(target), { recursive: true });
  await symlink(skillSource, target, process.platform === "win32" ? "junction" : "dir");
  return `CueLine skill installed: ${target}`;
}

export async function uninstallSkill(environment: NodeJS.ProcessEnv): Promise<string> {
  const target = skillTarget(environment);
  if (await linkMatches(target, skillSource)) {
    await unlink(target);
    return `CueLine skill removed: ${target}`;
  }
  if (await pathExists(target)) {
    return `CueLine preserved foreign path: ${target}`;
  }
  return `CueLine skill not installed: ${target}`;
}
