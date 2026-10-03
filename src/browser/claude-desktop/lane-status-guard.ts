export interface CueLineLaneContinuationStatus {
  continueAllowed: boolean;
  safeNextAction: unknown;
  phase?: string;
}

export interface CueLineLaneStatusGuardOptions<
  Status extends CueLineLaneContinuationStatus,
> {
  loadStatus(runId: string): Promise<Status>;
  onBlocked(status: Status): Promise<void>;
  sleep(ms: number): Promise<void>;
  pollIntervalMs?: number;
}

/** Poll the durable run status until it explicitly permits continuation. */
export async function waitForCueLineLaneContinuation<
  Status extends CueLineLaneContinuationStatus,
>(
  runId: string,
  options: CueLineLaneStatusGuardOptions<Status>,
): Promise<Status> {
  const pollIntervalMs = options.pollIntervalMs ?? 3_000;
  const stopPhases = new Set([
    "complete", "blocked", "cancelled", "round_limit_reached", "stagnation_detected",
    "cancellation_pending", "runtime_stale",
  ]);
  let previousBlocked: Status | undefined;
  for (;;) {
    const status = await options.loadStatus(runId);
    if (status.continueAllowed) return status;
    if (status.phase !== undefined && stopPhases.has(status.phase)) return status;
    if (
      previousBlocked === undefined ||
      status.phase !== previousBlocked.phase ||
      status.safeNextAction !== previousBlocked.safeNextAction
    ) {
      await options.onBlocked(status);
      previousBlocked = status;
    }
    await options.sleep(pollIntervalMs);
  }
}
