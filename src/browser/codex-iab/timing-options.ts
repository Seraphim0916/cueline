import { CueLineError } from "../../core/errors.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function validatedTimingOption(
  name: "timeoutMs" | "pollIntervalMs" | "stableMs",
  value: number,
  minimum: number,
  code: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > MAX_TIMER_DELAY_MS) {
    throw new CueLineError(
      code,
      `${name} must be an integer from ${minimum} through ${MAX_TIMER_DELAY_MS}.`,
      { details: { option: name, value, minimum, maximum: MAX_TIMER_DELAY_MS } },
    );
  }
  return value;
}
