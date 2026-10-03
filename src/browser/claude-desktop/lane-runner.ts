import { asCueLineError, CueLineError } from "../../core/errors.js";
import {
  waitForCueLineLaneContinuation,
  type CueLineLaneContinuationStatus,
} from "./lane-status-guard.js";

interface LaneRunResult {
  runId: string;
  status: string;
}

export interface ClaudeDesktopLaneDependencies<Browser, Result extends LaneRunResult, Status extends CueLineLaneContinuationStatus> {
  mode: { kind: "start"; request: string } | { kind: "resume"; runId: string };
  startRun(request: string): Promise<Result>;
  continueRun(runId: string, browser: Browser): Promise<Result>;
  loadStatus(runId: string): Promise<Status>;
  persistedConversationUrl(runId: string): Promise<string | undefined>;
  createBrowser(conversationUrl?: string): Browser | Promise<Browser>;
  record(entry: Record<string, unknown>): Promise<void>;
  sleep(ms: number): Promise<void>;
  maxUnclaimedTimeoutRetries?: number;
}

export async function runClaudeDesktopLane<Browser, Result extends LaneRunResult, Status extends CueLineLaneContinuationStatus>(
  deps: ClaudeDesktopLaneDependencies<Browser, Result, Status>,
): Promise<{ outcome: "finished" | "stopped"; runId: string; code?: string; status?: Status | Result }> {
  let runId: string | undefined;
  try {
    if (deps.mode.kind === "resume") {
      runId = deps.mode.runId;
      await deps.record({ event: "resuming", runId });
    } else {
      const result = await deps.startRun(deps.mode.request);
      runId = result.runId;
      await deps.record({ event: "created", runId, status: result.status, result });
    }
    const browser = await deps.createBrowser(await deps.persistedConversationUrl(runId));
    const maxRetries = deps.maxUnclaimedTimeoutRetries ?? 3;
    let unclaimedTimeoutRetries = 0;
    for (;;) {
      const status = await waitForCueLineLaneContinuation(runId, {
        loadStatus: deps.loadStatus,
        onBlocked: (blocked) => deps.record({
          event: "waiting", runId, phase: blocked.phase, safeNextAction: blocked.safeNextAction,
        }),
        sleep: deps.sleep,
      });
      if (!status.continueAllowed) {
        const outcome = status.phase === "complete" ? "finished" : "stopped";
        const code = status.phase ?? "CONTINUATION_NOT_ALLOWED";
        await deps.record({ event: outcome, runId, phase: status.phase, safeNextAction: status.safeNextAction });
        return outcome === "finished"
          ? { outcome, runId, status }
          : { outcome, runId, code, status };
      }
      let result: Result;
      try {
        result = await deps.continueRun(runId, browser);
      } catch (error) {
        if (
          error instanceof CueLineError && error.code === "HOST_BRIDGE_TIMEOUT" &&
          typeof error.details === "object" && error.details !== null &&
          (error.details as { claimed?: unknown }).claimed === false &&
          unclaimedTimeoutRetries < maxRetries
        ) {
          unclaimedTimeoutRetries += 1;
          await deps.record({ event: "retrying", runId, code: error.code, retry: unclaimedTimeoutRetries });
          continue;
        }
        throw error;
      }
      unclaimedTimeoutRetries = 0;
      await deps.record({ event: "progress", runId, status: result.status, result });
      if (result.status === "complete") {
        await deps.record({ event: "finished", runId, status: result.status, result });
        return { outcome: "finished", runId, status: result };
      }
    }
  } catch (error) {
    if (runId === undefined) throw error;
    const failure = asCueLineError(error);
    await deps.record({
      event: "failed", runId, code: failure.code, message: failure.message,
      resume: `cueline-claude-desktop-lane daemon --resume ${runId}`,
    });
    return { outcome: "stopped", runId, code: failure.code };
  }
}
