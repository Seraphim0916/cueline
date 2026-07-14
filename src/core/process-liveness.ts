import { runtimePlatform } from "./runtime.js";

function nativeProcess(): NodeJS.Process | undefined {
  return typeof process === "undefined" ? undefined : process;
}

export function processIsAlive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid < 1) return false;
  const native = nativeProcess();
  if (typeof native?.kill !== "function") return true;
  try {
    native.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

export function processOrGroupIsAlive(pid: number | undefined): boolean {
  if (processIsAlive(pid)) return true;
  const native = nativeProcess();
  if (
    runtimePlatform() === "win32" ||
    typeof native?.kill !== "function" ||
    pid === undefined ||
    !Number.isSafeInteger(pid) ||
    pid < 1
  ) {
    return false;
  }
  try {
    native.kill(-pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}
