import { randomUUID } from "node:crypto";
import path from "node:path";

interface CodexNodeRuntime {
  cwd?: string;
  homeDir?: string;
  requestMeta?: {
    "x-codex-turn-metadata"?: {
      session_id?: unknown;
    };
  };
}

declare global {
  var nodeRepl: CodexNodeRuntime | undefined;
}

function nativeProcess(): NodeJS.Process | undefined {
  return typeof process === "undefined" ? undefined : process;
}

export function runtimeEnvironment(): NodeJS.ProcessEnv {
  const native = nativeProcess();
  if (native !== undefined) return native.env;
  const home = globalThis.nodeRepl?.homeDir;
  const searchPath = [
    ...(home === undefined ? [] : [path.join(home, ".local", "bin")]),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(path.delimiter);
  return {
    ...(home === undefined ? {} : { HOME: home }),
    PATH: searchPath,
  };
}

export function runtimeCwd(): string {
  const native = nativeProcess();
  if (native !== undefined) return native.cwd();
  return globalThis.nodeRepl?.cwd ?? globalThis.nodeRepl?.homeDir ?? ".";
}

export function runtimePidTag(): string {
  return String(nativeProcess()?.pid ?? `repl-${randomUUID()}`);
}

export function runtimePlatform(): NodeJS.Platform | "posix" {
  return nativeProcess()?.platform ?? (path.delimiter === ";" ? "win32" : "posix");
}
