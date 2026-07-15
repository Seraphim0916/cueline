import type { BrowserAdapter } from "../browser/browser-adapter.js";
import type { JobStatus } from "../jobs/status.js";
import type { ControllerJobSpec } from "../protocol/types.js";
import type { RunnerSpec } from "../runners/runner-adapter.js";
import type {
  CueLineExecutor,
  CueLineRunState,
  CueLineRunStatus,
  StoredJob,
} from "./state-machine.js";

export interface JobSupervisorLike {
  start(spec: RunnerSpec): Promise<JobStatus>;
  waitForCompletion(jobId: string): Promise<JobStatus>;
  inspect(jobId: string): Promise<JobStatus>;
  cancel?(jobId: string): boolean;
  cancelAll?(): number;
}

export interface ControllerRuntimeOptions {
  browser: BrowserAdapter;
  jobSupervisor: JobSupervisorLike;
  resolveRunnerSpec: (jobId: string, job: ControllerJobSpec) => RunnerSpec;
  validateJobSpec?: (job: ControllerJobSpec) => void;
  home?: string;
  maxRounds?: number;
  maxRepairAttempts?: number;
  controllerInstructions?: readonly string[];
  conversationUrl?: string;
  now?: () => Date;
  signal?: AbortSignal;
  cancellationPollIntervalMs?: number;
  runTimeoutMs?: number;
  executor?: CueLineExecutor;
  allowProcessExecution?: boolean;
  maxConcurrency?: number;
  laneConcurrency?: Readonly<Record<string, number>>;
  runtimeHeartbeatIntervalMs?: number;
  returnAfterControllerSubmission?: boolean;
}

export interface ControllerLoopOptions extends ControllerRuntimeOptions {
  request: string;
  runId?: string;
}

export interface CreateControllerRunOptions {
  request: string;
  runId?: string;
  home?: string;
  now?: () => Date;
  executor?: CueLineExecutor;
  allowProcessExecution?: boolean;
  maxRounds?: number;
}

export interface ContinueControllerLoopOptions extends ControllerRuntimeOptions {
  runId: string;
  reconcileRequestId?: string;
  abandonOtherPendingTurns?: boolean;
}

export interface CueLineResult {
  runId: string;
  status:
    | Exclude<CueLineRunStatus, "running" | "failed">
    | "ready"
    | "awaiting_controller"
    | "awaiting_caller"
    | "awaiting_caller_work";
  finalDeliveryText?: string;
  conversationUrl?: string;
  cancelledReason?: string;
  state: CueLineRunState;
  pendingJobs?: StoredJob[];
}
