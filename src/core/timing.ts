import { CueLineError } from "./errors.js";

/** Largest delay Node can represent without reducing it to a near-immediate timer. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface TimerDelayValidationOptions {
  code: string;
  name: string;
  minimum?: 0 | 1;
}

export function validatedTimerDelay(
  value: number,
  options: TimerDelayValidationOptions,
): number {
  const minimum = options.minimum ?? 1;
  if (!Number.isSafeInteger(value) || value < minimum || value > MAX_TIMER_DELAY_MS) {
    const range =
      minimum === 0
        ? `an integer between 0 and ${MAX_TIMER_DELAY_MS}`
        : `a positive integer no greater than ${MAX_TIMER_DELAY_MS}`;
    throw new CueLineError(options.code, `${options.name} must be ${range}.`, {
      details: { value, minimum, maximum: MAX_TIMER_DELAY_MS },
    });
  }
  return value;
}
