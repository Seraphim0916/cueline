import type { BrowserAdapter } from "./browser/browser-adapter.js";
import type { CodexIabAdapterOptions } from "./browser/codex-iab/chatgpt-client.js";
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
  maxConcurrency?: number;
  laneConcurrency?: Readonly<Record<string, number>>;
}

export interface StartCueLineRunOptions extends CueLineRuntimeOptions {
  request: string;
  runId?: string;
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
