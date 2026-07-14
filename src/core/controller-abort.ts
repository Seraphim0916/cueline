import { CueLineError } from "./errors.js";

export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof CueLineError) throw signal.reason;
  throw new CueLineError("RUN_CANCELLED", "CueLine run cancellation was requested.", {
    cause: signal.reason,
  });
}
