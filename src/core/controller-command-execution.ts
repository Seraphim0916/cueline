import path from "node:path";

import { JobStatusStore, type JobStatus } from "../jobs/status.js";
import type { ControllerCommand, ControllerJobSpec } from "../protocol/types.js";
import { RunStore } from "../state/store.js";
import { throwIfCancelled } from "./controller-abort.js";
import { controllerResultOutput } from "./controller-turn.js";
import type { ControllerRuntimeOptions, JobSupervisorLike } from "./controller-types.js";
import { asCueLineError, CueLineError } from "./errors.js";
import { jobId } from "./ids.js";
import type { CueLineRunState, StoredJob } from "./state-machine.js";

export function statusPayload(status: JobStatus): Record<string, unknown> {
  const output = controllerResultOutput(status);
  return {
    job_id: status.jobId,
    status: status.status,
    ...(status.runnerId === undefined ? {} : { runner_id: status.runnerId }),
    ...(status.pid === undefined ? {} : { pid: status.pid }),
    ...(status.model === undefined ? {} : { model: status.model }),
    ...(status.provider === undefined ? {} : { provider: status.provider }),
    ...(status.phase === undefined ? {} : { phase: status.phase }),
    ...(status.lastProgressAt === undefined
      ? {}
      : { last_progress_at: status.lastProgressAt }),
    ...(output === undefined ? {} : { output }),
    ...(status.error === undefined ? {} : { error: status.error }),
  };
}

export function validateCommandBeforeAcceptance(
  store: RunStore<CueLineRunState>,
  command: ControllerCommand,
  options: ControllerRuntimeOptions,
): void {
  if (command.action !== "dispatch") return;
  for (const spec of command.jobs) {
    options.validateJobSpec?.(spec);
    if (store.state.executor === "caller" && spec.mode === "work") {
      if (spec.workdir === undefined || !path.isAbsolute(spec.workdir)) {
        throw new CueLineError(
          "CALLER_WORKDIR_REQUIRED",
          "Caller work requires an explicit absolute workdir so its durable claim is bound to one local workspace.",
        );
      }
      if (spec.background === true) {
        throw new CueLineError(
          "CALLER_WORK_BACKGROUND_UNSUPPORTED",
          "Caller work is handed back for an explicit claim; background process execution is not available in caller mode.",
        );
      }
    }
    const id = jobId(store.runId, spec.job_key, spec);
    const existing = Object.values(store.state.jobs).find(
      (job) => job.jobKey === spec.job_key,
    );
    if (existing !== undefined && existing.jobId !== id) {
      throw new CueLineError(
        "JOB_KEY_IDENTITY_MISMATCH",
        `job_key '${spec.job_key}' was already registered with a different immutable specification.`,
      );
    }
    if (store.state.jobs[id]) continue;
    if (store.state.executor !== "caller") options.resolveRunnerSpec(id, spec);
  }
}

async function updateRunningJobs(
  store: RunStore<CueLineRunState>,
  supervisor: JobSupervisorLike,
  jobIds?: string[],
): Promise<void> {
  const selected = Object.values(store.state.jobs).filter(
    (job) => job.status === "running" && (jobIds === undefined || jobIds.includes(job.jobId)),
  );
  const statuses = await Promise.all(
    selected.map((job) => supervisor.waitForCompletion(job.jobId)),
  );
  for (const status of statuses) {
    await store.append("job_status", statusPayload(status));
  }
}

interface StartedDispatchedJob {
  jobId: string;
  backgroundAdvice: boolean;
  completion: Promise<Record<string, unknown>>;
}

async function registerDispatchedJob(
  store: RunStore<CueLineRunState>,
  spec: ControllerJobSpec,
  resumeExistingPending = false,
): Promise<StoredJob | undefined> {
  const id = jobId(store.runId, spec.job_key, spec);
  const existing = Object.values(store.state.jobs).find(
    (job) => job.jobKey === spec.job_key,
  );
  if (existing !== undefined && existing.jobId !== id) {
    throw new CueLineError(
      "JOB_KEY_IDENTITY_MISMATCH",
      `job_key '${spec.job_key}' was already registered with a different immutable specification.`,
    );
  }
  if (store.state.jobs[id]) {
    if (resumeExistingPending && store.state.jobs[id]?.status === "pending") {
      return store.state.jobs[id];
    }
    await store.append("notice", {
      message: `duplicate dispatch ignored for job_key '${spec.job_key}' (${id})`,
    });
    return undefined;
  }
  const job: StoredJob = {
    jobId: id,
    jobKey: spec.job_key,
    required: spec.required ?? true,
    spec,
    status: "pending",
    output: null,
    error: null,
    ...(store.state.executor === "caller" && spec.mode === "work"
      ? { callerWork: { claim: null, nextFencingToken: 0 } }
      : {}),
  };
  await store.append("job_registered", { job });
  return job;
}

async function startDispatchedJob(
  store: RunStore<CueLineRunState>,
  spec: ControllerJobSpec,
  options: ControllerRuntimeOptions,
  resumeExistingPending = false,
): Promise<StartedDispatchedJob | undefined> {
  throwIfCancelled(options.signal);
  const job = await registerDispatchedJob(store, spec, resumeExistingPending);
  if (!job) return undefined;
  const id = job.jobId;
  try {
    const runnerSpec = options.resolveRunnerSpec(id, spec);
    const startedAt = (options.now ?? (() => new Date()))().toISOString();
    await store.append("job_status", {
      job_id: id,
      status: "running",
      ...(runnerSpec.runnerId === undefined ? {} : { runner_id: runnerSpec.runnerId }),
      phase: "starting",
      last_progress_at: startedAt,
    });
    return {
      jobId: id,
      backgroundAdvice: spec.mode === "advise" && spec.background === true,
      completion: options.jobSupervisor.start({
        ...runnerSpec,
        runId: store.runId,
        jobKey: spec.job_key,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }).then(
        async (status) =>
          statusPayload(
            spec.mode === "work" &&
              (status.status === "pending" || status.status === "running")
              ? await options.jobSupervisor.waitForCompletion(id)
              : status,
          ),
        (error: unknown) => {
          const failure = asCueLineError(error, "JOB_START_FAILED");
          return {
            job_id: id,
            status: "failed",
            error: failure.message,
          };
        },
      ),
    };
  } catch (error) {
    const failure = asCueLineError(error, "JOB_START_FAILED");
    await store.append("job_status", {
      job_id: id,
      status: "failed",
      error: failure.message,
    });
    return undefined;
  }
}

async function executeProcessDispatch(
  store: RunStore<CueLineRunState>,
  specs: readonly ControllerJobSpec[],
  options: ControllerRuntimeOptions,
  resumeExistingPending = false,
): Promise<void> {
  const previouslyRunning = Object.values(store.state.jobs).filter(
    (job) => job.status === "running",
  );
  const globalLimit =
    specs.some((spec) => spec.mode === "work") ||
    previouslyRunning.some((job) => job.spec.mode === "work")
    ? 1
    : (options.maxConcurrency ?? 2);
  const queued = [...specs];
  const active: Array<{
    jobId: string;
    lane: string;
    backgroundAdvice: boolean;
    waitingForTerminal: boolean;
    completion: Promise<Record<string, unknown>>;
  }> = previouslyRunning.map((job) => ({
    jobId: job.jobId,
    lane: job.spec.lane,
    backgroundAdvice: job.spec.mode === "advise" && job.spec.background === true,
    waitingForTerminal: true,
    completion: options.jobSupervisor.waitForCompletion(job.jobId).then(
      statusPayload,
      (error: unknown) => {
        const failure = asCueLineError(error, "JOB_WAIT_FAILED");
        return {
          job_id: job.jobId,
          status: "failed",
          error: failure.message,
        };
      },
    ),
  }));
  const activeByLane = new Map<string, number>();
  for (const entry of active) {
    activeByLane.set(entry.lane, (activeByLane.get(entry.lane) ?? 0) + 1);
  }

  while (queued.length > 0 || active.length > 0) {
    let started = false;
    for (let index = 0; index < queued.length && active.length < globalLimit; ) {
      const spec = queued[index]!;
      const laneLimit =
        options.laneConcurrency !== undefined &&
        Object.prototype.hasOwnProperty.call(options.laneConcurrency, spec.lane)
          ? options.laneConcurrency[spec.lane]!
          : globalLimit;
      const laneActive = activeByLane.get(spec.lane) ?? 0;
      if (laneActive >= laneLimit) {
        index += 1;
        continue;
      }
      queued.splice(index, 1);
      const job = await startDispatchedJob(
        store,
        spec,
        options,
        resumeExistingPending,
      );
      if (job) {
        active.push({
          jobId: job.jobId,
          lane: spec.lane,
          backgroundAdvice: job.backgroundAdvice,
          waitingForTerminal: false,
          completion: job.completion,
        });
        activeByLane.set(spec.lane, laneActive + 1);
      }
      started = true;
    }
    if (queued.length === 0) {
      for (let index = active.length - 1; index >= 0; index -= 1) {
        const entry = active[index]!;
        if (!entry.backgroundAdvice || !entry.waitingForTerminal) continue;
        void entry.completion.catch(() => undefined);
        active.splice(index, 1);
        const remaining = (activeByLane.get(entry.lane) ?? 1) - 1;
        if (remaining === 0) activeByLane.delete(entry.lane);
        else activeByLane.set(entry.lane, remaining);
      }
    }
    if (active.length === 0) {
      if (!started && queued.length > 0) {
        throw new CueLineError(
          "JOB_CONCURRENCY_DEADLOCK",
          "No queued job can start under the configured concurrency limits.",
        );
      }
      continue;
    }
    const settled = await Promise.race(
      active.map((entry) =>
        entry.completion.then((payload) => ({ entry, payload })),
      ),
    );
    const activeIndex = active.indexOf(settled.entry);
    await store.append("job_status", settled.payload);
    if (
      settled.entry.backgroundAdvice &&
      !settled.entry.waitingForTerminal &&
      settled.payload.status === "running" &&
      queued.length > 0
    ) {
      settled.entry.waitingForTerminal = true;
      settled.entry.completion = options.jobSupervisor
        .waitForCompletion(settled.entry.jobId)
        .then(statusPayload, (error: unknown) => {
          const failure = asCueLineError(error, "JOB_WAIT_FAILED");
          return {
            job_id: settled.entry.jobId,
            status: "failed",
            error: failure.message,
          };
        });
      continue;
    }
    if (activeIndex >= 0) active.splice(activeIndex, 1);
    const remaining = (activeByLane.get(settled.entry.lane) ?? 1) - 1;
    if (remaining === 0) activeByLane.delete(settled.entry.lane);
    else activeByLane.set(settled.entry.lane, remaining);
  }
}

export type CommandExecutionOutcome =
  | "continue"
  | "terminal"
  | "awaiting_controller"
  | "awaiting_caller";

async function executeCommand(
  store: RunStore<CueLineRunState>,
  command: ControllerCommand,
  options: ControllerRuntimeOptions,
  resumePendingExecution = false,
): Promise<CommandExecutionOutcome> {
  if (command.action === "dispatch") {
    if ((options.executor ?? store.state.executor) === "caller") {
      for (const spec of command.jobs) {
        const job = await registerDispatchedJob(
          store,
          spec,
          resumePendingExecution,
        );
        if (job !== undefined) {
          const statusStore = new JobStatusStore(store.paths.home);
          if ((await statusStore.read(job.jobId)) === undefined) {
            await statusStore.write({
              jobId: job.jobId,
              runId: store.runId,
              jobKey: job.jobKey,
              lane: job.spec.lane,
              mode: job.spec.mode,
              execution: "foreground",
              status: "pending",
              startedAt: (options.now ?? (() => new Date()))().toISOString(),
            });
          }
        }
      }
      const pendingIds = Object.values(store.state.jobs)
        .filter((job) => job.status === "pending" || job.status === "running")
        .map((job) => job.jobId);
      await store.append("caller_jobs_ready", { job_ids: pendingIds });
      return pendingIds.length > 0 ? "awaiting_caller" : "continue";
    }
    await executeProcessDispatch(
      store,
      command.jobs,
      options,
      resumePendingExecution,
    );
    throwIfCancelled(options.signal);
    return "continue";
  }

  if (command.action === "wait") {
    if ((options.executor ?? store.state.executor) === "caller") {
      const active = Object.values(store.state.jobs).some(
        (job) =>
          (job.status === "pending" || job.status === "running") &&
          (command.job_ids === undefined || command.job_ids.includes(job.jobId)),
      );
      return active ? "awaiting_caller" : "continue";
    }
    await updateRunningJobs(store, options.jobSupervisor, command.job_ids);
    return "continue";
  }

  if (command.action === "inspect") {
    if ((options.executor ?? store.state.executor) === "caller") {
      const active = Object.values(store.state.jobs).some(
        (job) =>
          (job.status === "pending" || job.status === "running") &&
          (command.job_ids === undefined || command.job_ids.includes(job.jobId)),
      );
      return active ? "awaiting_caller" : "continue";
    }
    const selected = Object.values(store.state.jobs).filter(
      (job) => command.job_ids === undefined || command.job_ids.includes(job.jobId),
    );
    for (const job of selected) {
      try {
        const status = await options.jobSupervisor.inspect(job.jobId);
        await store.append("job_status", statusPayload(status));
      } catch (error) {
        const failure = asCueLineError(error, "JOB_INSPECT_FAILED");
        await store.append("notice", {
          message: `inspection failed for '${job.jobKey}': ${failure.message}`,
        });
      }
    }
    return "continue";
  }

  if (command.action === "complete" || command.action === "blocked") {
    const activeJobs = Object.values(store.state.jobs).filter(
      (job) => job.status === "pending" || job.status === "running",
    );
    if (activeJobs.length > 0) {
      await store.append("notice", {
        message: `${command.action} rejected: jobs still pending or running: ${activeJobs
          .map((job) => job.jobKey)
          .join(", ")}`,
      });
      return "continue";
    }
  }

  if (command.action === "complete") {
    await store.append("run_completed", { final_delivery_text: command.final_delivery_text });
    return "terminal";
  }

  await store.append("run_blocked", {
    reason: command.reason,
    ...(command.final_delivery_text === undefined
      ? {}
      : { final_delivery_text: command.final_delivery_text }),
  });
  return "terminal";
}

export async function executeAcceptedCommand(
  store: RunStore<CueLineRunState>,
  command: ControllerCommand,
  commandDigest: string,
  options: ControllerRuntimeOptions,
  resumePendingExecution = false,
): Promise<CommandExecutionOutcome> {
  const outcome = await executeCommand(
    store,
    command,
    options,
    resumePendingExecution,
  );
  await store.append("controller_command_execution_completed", {
    command_hash: commandDigest,
    action: command.action,
  });
  return outcome;
}
