import { access, lstat, mkdir, readlink, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const codexSkillSource = fileURLToPath(new URL("../../../skills/cueline", import.meta.url));
const claudeSkillSource = fileURLToPath(
  new URL("../../../skills/cueline-host", import.meta.url),
);

export type SkillLinkScope = "all" | "codex-only" | "claude-only";

interface SkillLink {
  source: string;
  target: string;
}

function codexHome(environment: NodeJS.ProcessEnv): string {
  if (environment.CODEX_HOME) return path.resolve(environment.CODEX_HOME);
  const home = environment.HOME || homedir();
  return path.join(home, ".codex");
}

function claudeConfigDir(environment: NodeJS.ProcessEnv): string {
  if (environment.CLAUDE_CONFIG_DIR) return path.resolve(environment.CLAUDE_CONFIG_DIR);
  const home = environment.HOME || homedir();
  return path.join(home, ".claude");
}

function skillLinks(environment: NodeJS.ProcessEnv, scope: SkillLinkScope): readonly SkillLink[] {
  const codexLink = {
    source: codexSkillSource,
    target: path.join(codexHome(environment), "skills", "cueline"),
  };
  const claudeLink = {
    source: claudeSkillSource,
    target: path.join(claudeConfigDir(environment), "skills", "cueline-host"),
  };
  if (scope === "codex-only") return [codexLink];
  if (scope === "claude-only") return [claudeLink];
  return [codexLink, claudeLink];
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

export async function installSkill(
  environment: NodeJS.ProcessEnv,
  scope: SkillLinkScope = "all",
): Promise<string> {
  const links = skillLinks(environment, scope);
  const installed = new Set<string>();

  for (const link of links) {
    await access(path.join(link.source, "SKILL.md"));
    if (await linkMatches(link.target, link.source)) {
      installed.add(link.target);
    } else if (await pathExists(link.target)) {
      throw new Error(`refusing to replace foreign path: ${link.target}`);
    }
  }

  const messages: string[] = [];
  for (const link of links) {
    if (installed.has(link.target)) {
      messages.push(`CueLine skill already installed: ${link.target}`);
      continue;
    }
    await mkdir(path.dirname(link.target), { recursive: true });
    await symlink(link.source, link.target, process.platform === "win32" ? "junction" : "dir");
    messages.push(`CueLine skill installed: ${link.target}`);
  }
  return messages.join("\n");
}

export async function uninstallSkill(
  environment: NodeJS.ProcessEnv,
  scope: SkillLinkScope = "all",
): Promise<string> {
  const messages: string[] = [];
  for (const link of skillLinks(environment, scope)) {
    if (await linkMatches(link.target, link.source)) {
      await unlink(link.target);
      messages.push(`CueLine skill removed: ${link.target}`);
    } else if (await pathExists(link.target)) {
      messages.push(`CueLine preserved foreign path: ${link.target}`);
    } else {
      messages.push(`CueLine skill not installed: ${link.target}`);
    }
  }
  return messages.join("\n");
}
