import type { BrowserAdapter } from "./browser/browser-adapter.js";
import type { CodexIabAdapterOptions } from "./browser/codex-iab/chatgpt-client.js";
import type { CueLineRunStatusSummary } from "./core/run-status.js";
import type { RoutingConfig } from "./router/types.js";
import type { JobResultStatus } from "./runners/runner-adapter.js";

export interface CueLineRuntimeOptions {
  browser?: BrowserAdapter;
  browserOptions?: Omit<CodexIabAdapterOptions, "conversationUrl">;
  conversationUrl?: string;
  routingConfig?: RoutingConfig;
  routingConfigPath?: string;
  home?: string;
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  defaultTimeoutMs?: number;
  maxRounds?: number;
  maxRepairAttempts?: number;
  now?: () => Date;
  signal?: AbortSignal;
  cancellationPollIntervalMs?: number;
  runTimeoutMs?: number;
  executor?: "caller" | "process";
  /** Required together with executor="process" before CueLine may spawn local processes. */
  allowProcessExecution?: boolean;
  maxConcurrency?: number;
  laneConcurrency?: Readonly<Record<string, number>>;
  /** Opt in to archiving the exact ChatGPT controller conversation after a durable complete. */
  archiveControllerConversationOnComplete?: boolean;
}

export interface StartCueLineRunOptions extends CueLineRuntimeOptions {
  request: string;
  runId?: string;
}

export type CueLineRunListEntry =
  | {
      runId: string;
      readable: true;
      status: CueLineRunStatusSummary["status"];
      executor: CueLineRunStatusSummary["executor"];
      phase: CueLineRunStatusSummary["phase"];
      round: number;
      pendingTurns: number;
      activeJobs: number;
      runtimeOwnership: CueLineRunStatusSummary["runtime"]["ownership"];
      safeNextAction: CueLineRunStatusSummary["safeNextAction"];
      lastEventSequence: number;
      lastEventAt: string;
    }
  | {
      runId: string;
      readable: false;
      errorCode: string;
    };

export type CueLineRunVerificationOutcome = "verified" | "degraded" | "unreadable";

export interface CueLineRunVerificationFinding {
  code: string;
  severity: "warning" | "error";
  surface: "marker" | "events" | "snapshot" | "runtime" | "jobs";
  message: string;
}

export interface CueLineRunVerificationReport {
  runId: string;
  outcome: CueLineRunVerificationOutcome;
  marker: "valid" | "missing" | "invalid";
  eventLog:
    | {
        readable: true;
        totalEvents: number;
        authoritativeEvents: number;
        lastSequence: number;
      }
    | {
        readable: false;
        totalEvents: 0;
        authoritativeEvents: 0;
        lastSequence: null;
      };
  snapshot: "missing" | "valid" | "stale" | "invalid";
  runtimeOwnership: "missing" | "active" | "stale" | "released" | "invalid";
  findings: CueLineRunVerificationFinding[];
}

export interface ContinueCueLineRunOptions extends CueLineRuntimeOptions {
  runId: string;
  reconcileRequestId?: string;
  abandonOtherPendingTurns?: boolean;
  manualSendConfirmed?: boolean;
}

export interface ManualControllerSubmissionConfirmation {
  runId: string;
  requestId: string;
  conversationUrl: string;
  outcome: "confirmed" | "already_confirmed";
}

export interface ControllerNotSentConfirmation {
  runId: string;
  requestId: string;
  conversationUrl: string;
  promptHash: string;
  outcome: "confirmed" | "already_confirmed";
}

export interface CueLineCallerJobResultInput {
  status: JobResultStatus;
  stdout?: string;
  stderr?: string;
  output?: string;
  error?: string;
  exitCode?: number | null;
  startedAt?: string;
  finishedAt?: string;
}

export interface CueLineCallerJobSubmissionResult {
  runId: string;
  jobId: string;
  outcome: "submitted" | "already_terminal";
}

export interface CueLineCallerWorkClaimProof {
  claimId: string;
  callerId: string;
  fencingToken: number;
}

export interface CueLineCallerWorkClaimOptions
  extends Pick<CueLineRuntimeOptions, "home" | "environment" | "now"> {
  callerId: string;
  ttlMs?: number;
}

export interface CueLineCallerWorkClaimResult extends CueLineCallerWorkClaimProof {
  runId: string;
  jobId: string;
  outcome: "claimed" | "already_claimed";
  task: string;
  taskHash: string;
  workdir: string;
  /** Canonical directory pinned by the durable claim; execute work only here. */
  resolvedWorkdir: string;
  claimedAt: string;
  heartbeatAt: string;
  expiresAt: string;
  started: boolean;
}

export interface CueLineCallerWorkMutationResult {
  runId: string;
  jobId: string;
  claimId: string;
  fencingToken: number;
  outcome:
    | "started"
    | "already_started"
    | "heartbeat_recorded"
    | "released";
  heartbeatAt?: string;
  expiresAt?: string;
}

export interface CueLineCallerWorkMutationOptions
  extends Pick<CueLineRuntimeOptions, "home" | "environment" | "now"> {}

export interface CueLineCallerJobSubmissionOptions
  extends Pick<CueLineRuntimeOptions, "home" | "environment" | "now"> {
  claim?: CueLineCallerWorkClaimProof;
}

export interface CueLineRuntimeReconciliationResult {
  runId: string;
  outcome: "reconciled" | "owner_alive" | "processes_alive" | "already_terminal";
  affectedJobs: number;
  survivingJobs: string[];
}

export interface CueLineRuntimeTakeoverResult {
  runId: string;
  outcome: "taken_over" | "already_available" | "already_terminal";
  next: "continue" | "reconcile_runtime" | "none";
  previousOwnerId?: string;
}

export interface CueLineRunCancellationResult {
  runId: string;
  outcome: "requested" | "cancelled" | "already_terminal";
  affectedJobs: number;
}

export interface CueLineJobCancellationResult {
  runId: string;
  jobId: string;
  outcome: "requested" | "cancelled" | "ambiguous" | "already_terminal";
}
