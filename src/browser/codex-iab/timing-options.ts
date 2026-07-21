import { validatedTimerDelay } from "../../core/timing.js";

export function validatedTimingOption(
  name: "timeoutMs" | "pollIntervalMs" | "stableMs" | "pendingDiagnosticMs",
  value: number,
  minimum: 0 | 1,
  code: string,
): number {
  return validatedTimerDelay(value, { code, name, minimum });
}
