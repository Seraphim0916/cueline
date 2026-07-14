import type { JobMode } from "../protocol/types.js";

export type JobExecution = "foreground" | "background";
export type JobResultStatus = "succeeded" | "failed" | "timed_out" | "ambiguous";

export interface RunnerSpec {
  jobId: string;
  argv: readonly string[];
  stdin?: string;
  mode: JobMode;
  timeoutMs: number;
  background?: boolean;
  lane?: string;
  task?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface JobResult {
  status: JobResultStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  output: string;
  emptyOutput: boolean;
  timedOut: boolean;
  ambiguousSideEffects: boolean;
  retryable: false;
  startedAt: string;
  finishedAt: string;
}

export interface RunnerAdapter {
  run(spec: RunnerSpec): Promise<JobResult>;
}

export function executionFor(spec: Pick<RunnerSpec, "background">): JobExecution {
  return spec.background === true ? "background" : "foreground";
}
