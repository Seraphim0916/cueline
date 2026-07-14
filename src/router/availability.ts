import { constants, accessSync } from "node:fs";
import path from "node:path";

import { runtimeCwd, runtimeEnvironment, runtimePlatform } from "../core/runtime.js";
import type { CandidateAvailabilityChecker, RouteCandidate } from "./types.js";

function executableNames(command: string, environment: NodeJS.ProcessEnv): string[] {
  if (runtimePlatform() !== "win32" || path.extname(command) !== "") {
    return [command];
  }
  const extensions = (environment.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter(Boolean);
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
}

function canExecute(filePath: string): boolean {
  try {
    accessSync(filePath, runtimePlatform() === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findExecutable(
  command: string,
  environment: NodeJS.ProcessEnv = runtimeEnvironment(),
  cwd = runtimeCwd(),
): string | undefined {
  if (command.trim() === "") return undefined;
  if (command.includes(path.sep) || (path.sep === "\\" && command.includes("/"))) {
    const candidate = path.resolve(cwd, command);
    return canExecute(candidate) ? candidate : undefined;
  }

  const directories = (environment.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const name of executableNames(command, environment)) {
      const candidate = path.join(directory, name);
      if (canExecute(candidate)) return candidate;
    }
  }
  return undefined;
}

export function executableAvailability(
  environment: NodeJS.ProcessEnv = runtimeEnvironment(),
  cwd = runtimeCwd(),
): CandidateAvailabilityChecker {
  const cache = new Map<string, boolean>();
  return {
    isAvailable(candidate: RouteCandidate): boolean {
      const executable = candidate.argv[0];
      if (executable === undefined) return false;
      const cached = cache.get(executable);
      if (cached !== undefined) return cached;
      const available = findExecutable(executable, environment, cwd) !== undefined;
      cache.set(executable, available);
      return available;
    },
  };
}
