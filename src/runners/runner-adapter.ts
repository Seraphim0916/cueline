import type { JobMode } from "../protocol/types.js";

export type JobExecution = "foreground" | "background";
export type JobResultStatus =
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "ambiguous";

export interface RunnerSpec {
  jobId: string;
  /** Resolved routing candidate, persisted before process spawn. */
  runnerId?: string;
  runId?: string;
  jobKey?: string;
  argv: readonly string[];
  stdin?: string;
  mode: JobMode;
  timeoutMs: number;
  background?: boolean;
  lane?: string;
  task?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface JobResult {
  status: JobResultStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  output: string;
  emptyOutput: boolean;
  timedOut: boolean;
  cancelled: boolean;
  ambiguousSideEffects: boolean;
  retryable: false;
  startedAt: string;
  finishedAt: string;
}

export interface RunnerRunHooks {
  onSpawn?(pid: number): void | Promise<void>;
  onProgress?(progress: RunnerProgress): void | Promise<void>;
}

export interface RunnerProgress {
  phase: string;
  at: string;
  model?: string;
  provider?: string;
}

export interface RunnerAdapter {
  run(spec: RunnerSpec, hooks?: RunnerRunHooks): Promise<JobResult>;
}

export function executionFor(spec: Pick<RunnerSpec, "background">): JobExecution {
  return spec.background === true ? "background" : "foreground";
}
