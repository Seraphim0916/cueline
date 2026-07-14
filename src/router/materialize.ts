import { CueLineError } from "../core/errors.js";
import { runtimeCwd } from "../core/runtime.js";
import type { ControllerJobSpec } from "../protocol/types.js";
import type { RunnerSpec } from "../runners/runner-adapter.js";
import type { ResolvedRoute } from "./types.js";

export interface MaterializeRunnerOptions {
  cwd?: string;
  timeoutMs?: number;
}

const TOKEN_PATTERN = /\{(job_id|lane|mode|sandbox|task|workdir)\}/g;

export function materializeRunnerSpec(
  jobId: string,
  job: ControllerJobSpec,
  route: ResolvedRoute,
  options: MaterializeRunnerOptions = {},
): RunnerSpec {
  const cwd = job.workdir ?? options.cwd ?? runtimeCwd();
  const taskInput = route.candidate.task_input ?? "argv";
  let placedTask = false;
  const values: Record<string, string> = {
    job_id: jobId,
    lane: route.lane,
    mode: job.mode,
    sandbox: job.mode === "advise" ? "read-only" : "workspace-write",
    task: job.task,
    workdir: cwd,
  };
  const argv = route.candidate.argv.map((part) =>
    part.replace(TOKEN_PATTERN, (_match, token: string) => {
      if (token === "task") placedTask = true;
      return values[token] ?? "";
    }),
  );

  if (taskInput === "argv" && !placedTask) {
    throw new CueLineError(
      "ROUTE_TEMPLATE_TASK_MISSING",
      `runner '${route.candidate.id}' uses argv input but has no {task} placeholder`,
      { details: { lane: route.lane, candidate: route.candidate.id } },
    );
  }
  if (taskInput === "stdin" && placedTask) {
    throw new CueLineError(
      "ROUTE_TEMPLATE_TASK_DUPLICATE",
      `runner '${route.candidate.id}' cannot use both stdin and a {task} placeholder`,
      { details: { lane: route.lane, candidate: route.candidate.id } },
    );
  }

  return {
    jobId,
    argv,
    ...(taskInput === "stdin" ? { stdin: job.task } : {}),
    mode: job.mode,
    timeoutMs: job.timeout_ms ?? options.timeoutMs ?? 10 * 60 * 1_000,
    lane: route.lane,
    task: job.task,
    cwd,
    ...(job.background === undefined ? {} : { background: job.background }),
  };
}
