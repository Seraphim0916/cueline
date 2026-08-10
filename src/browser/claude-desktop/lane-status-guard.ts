export interface CueLineLaneContinuationStatus {
  continueAllowed: boolean;
  safeNextAction: unknown;
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
  for (;;) {
    const status = await options.loadStatus(runId);
    if (status.continueAllowed) return status;
    await options.onBlocked(status);
    await options.sleep(pollIntervalMs);
  }
}
