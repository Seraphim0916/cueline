import { fileURLToPath } from "node:url";

import type { BrowserAdapter } from "./browser/browser-adapter.js";
import {
  createCodexIabAdapter,
  type CodexIabAdapterOptions,
} from "./browser/codex-iab/chatgpt-client.js";
import {
  continueControllerLoop,
  runControllerLoop,
  type CueLineResult,
} from "./core/controller-loop.js";
import { CueLineError } from "./core/errors.js";
import { runtimeCwd, runtimeEnvironment } from "./core/runtime.js";
import {
  acceptedControllerCommandEvidence,
  assertRunCanContinue,
  summarizeCueLineRunState,
  type CueLineRunStatusSummary,
} from "./core/run-status.js";
import {
  initialRunState,
  reduceRunState,
  type CueLineRunState,
} from "./core/state-machine.js";
import { JobStatusStore } from "./jobs/status.js";
import { JobSupervisor } from "./jobs/supervisor.js";
import type { ControllerJobSpec } from "./protocol/types.js";
import { executableAvailability } from "./router/availability.js";
import { loadRoutingConfig } from "./router/config-loader.js";
import { materializeRunnerSpec } from "./router/materialize.js";
import { resolveRoute } from "./router/resolver.js";
import type { RoutingConfig } from "./router/types.js";
import { ProcessRunner } from "./runners/process-runner.js";
import { RunnerRegistry } from "./runners/registry.js";
import {
  readCancellationObservation,
  requestJobCancellation,
  requestRunCancellation,
} from "./state/cancellation.js";
import { readEvents } from "./state/event-log.js";
import { defaultCueLineHome, runPaths } from "./state/paths.js";
import { readRuntimeLease } from "./state/runtime-lease.js";
import { RunStore } from "./state/store.js";

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
}

export interface StartCueLineRunOptions extends CueLineRuntimeOptions {
  request: string;
  runId?: string;
}

export interface ContinueCueLineRunOptions extends CueLineRuntimeOptions {
  runId: string;
  reconcileRequestId?: string;
  abandonOtherPendingTurns?: boolean;
}

export interface CueLineRunCancellationResult {
  runId: string;
  outcome: "requested" | "cancelled" | "already_terminal";
  affectedJobs: number;
}

export interface CueLineJobCancellationResult {
  runId: string;
  jobId: string;
  outcome: "requested" | "ambiguous" | "already_terminal";
}

interface PreparedRuntime {
  browser: BrowserAdapter;
  jobSupervisor: JobSupervisor;
  resolveRunnerSpec: (
    jobId: string,
    job: ControllerJobSpec,
  ) => ReturnType<typeof materializeRunnerSpec>;
  controllerInstructions: readonly string[];
  conversationUrl?: string;
  home: string;
}

function assertNotNested(environment: NodeJS.ProcessEnv): void {
  if (environment.CUELINE_DEPTH !== undefined) {
    throw new CueLineError("NESTED_ROUTING_REJECTED", "nested CueLine routing is not allowed");
  }
}

export function defaultRoutingConfigPath(): string {
  return fileURLToPath(new URL("../../config/routing.default.json", import.meta.url));
}

export function routingConfigPath(
  environment: NodeJS.ProcessEnv = runtimeEnvironment(),
  explicitPath?: string,
): string {
  return explicitPath ?? environment.CUELINE_CONFIG ?? defaultRoutingConfigPath();
}

async function persistedRunStore(
  home: string,
  runId: string,
): Promise<RunStore<CueLineRunState>> {
  const store = await RunStore.load({
    home,
    runId,
    initialState: initialRunState(runId, ""),
    reducer: reduceRunState,
  });
  const state = store.state;
  if (state.request === "") {
    throw new CueLineError("RUN_NOT_FOUND", `No persisted CueLine run '${runId}' was found.`);
  }
  return store;
}

async function persistedRunState(home: string, runId: string): Promise<CueLineRunState> {
  return (await persistedRunStore(home, runId)).state;
}

function terminalResult(state: CueLineRunState): CueLineResult {
  if (
    state.status !== "complete" &&
    state.status !== "blocked" &&
    state.status !== "cancelled"
  ) {
    throw new CueLineError("RUN_NOT_TERMINAL", "CueLine result requested before a terminal state.");
  }
  return {
    runId: state.runId,
    status: state.status,
    ...(state.finalDeliveryText === null ? {} : { finalDeliveryText: state.finalDeliveryText }),
    ...(state.conversationUrl === null ? {} : { conversationUrl: state.conversationUrl }),
    ...(state.cancelledReason === null ? {} : { cancelledReason: state.cancelledReason }),
    state,
  };
}

export async function loadCueLineRunState(
  runId: string,
  options: Pick<CueLineRuntimeOptions, "home" | "environment"> = {},
): Promise<CueLineRunState> {
  const environment = options.environment ?? runtimeEnvironment();
  return persistedRunState(options.home ?? defaultCueLineHome(environment), runId);
}

export async function loadCueLineRunStatus(
  runId: string,
  options: Pick<CueLineRuntimeOptions, "home" | "environment" | "now"> = {},
): Promise<CueLineRunStatusSummary> {
  const environment = options.environment ?? runtimeEnvironment();
  const home = options.home ?? defaultCueLineHome(environment);
  const store = await persistedRunStore(home, runId);
  const runtime = await readRuntimeLease(home, runId, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const cancellation = await readCancellationObservation(home, runId);
  const acceptedCommand = acceptedControllerCommandEvidence(
    await readEvents(runPaths(home, runId).events),
  );
  return summarizeCueLineRunState(
    store.state,
    store.lastSequence,
    runtime,
    cancellation,
    acceptedCommand,
  );
}

function isTerminalRun(state: CueLineRunState): boolean {
  return (
    state.status === "complete" || state.status === "blocked" || state.status === "cancelled"
  );
}

export async function cancelCueLineRun(
  runId: string,
  options: Pick<CueLineRuntimeOptions, "home" | "environment" | "now"> & {
    reason?: string;
  } = {},
): Promise<CueLineRunCancellationResult> {
  const environment = options.environment ?? runtimeEnvironment();
  const home = options.home ?? defaultCueLineHome(environment);
  const store = await persistedRunStore(home, runId);
  if (isTerminalRun(store.state)) {
    return { runId, outcome: "already_terminal", affectedJobs: 0 };
  }
  const reason = options.reason ?? "operator requested cancellation";
  await requestRunCancellation(home, runId, reason, options.now);
  const runtime = await readRuntimeLease(home, runId, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (
    runtime.ownership === "active" ||
    runtime.ownership === "stale" ||
    runtime.ownership === "invalid"
  ) {
    return { runId, outcome: "requested", affectedJobs: 0 };
  }
  const active = Object.values(store.state.jobs).filter(
    (job) => job.status === "pending" || job.status === "running",
  );
  for (const job of active) {
    await store.append("job_status", {
      job_id: job.jobId,
      status: "ambiguous",
      error: "Run cancelled without a verifiable active runtime; process outcome is unknown.",
    });
  }
  await store.append("run_cancelled", { reason });
  await store.snapshot();
  return { runId, outcome: "cancelled", affectedJobs: active.length };
}

export async function cancelCueLineJob(
  runId: string,
  jobId: string,
  options: Pick<CueLineRuntimeOptions, "home" | "environment" | "now"> & {
    reason?: string;
  } = {},
): Promise<CueLineJobCancellationResult> {
  const environment = options.environment ?? runtimeEnvironment();
  const home = options.home ?? defaultCueLineHome(environment);
  const store = await persistedRunStore(home, runId);
  const job = store.state.jobs[jobId];
  if (job === undefined) {
    throw new CueLineError("JOB_NOT_FOUND", `No job '${jobId}' exists in run '${runId}'.`);
  }
  if (
    isTerminalRun(store.state) ||
    (job.status !== "pending" && job.status !== "running")
  ) {
    return { runId, jobId, outcome: "already_terminal" };
  }
  const reason = options.reason ?? "operator requested job cancellation";
  await requestJobCancellation(home, runId, jobId, reason, options.now);
  const runtime = await readRuntimeLease(home, runId, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (
    runtime.ownership === "active" ||
    runtime.ownership === "stale" ||
    runtime.ownership === "invalid"
  ) {
    return { runId, jobId, outcome: "requested" };
  }
  await store.append("job_status", {
    job_id: jobId,
    status: "ambiguous",
    error: "Job cancelled without a verifiable active runtime; process outcome is unknown.",
  });
  if (store.state.status === "running") {
    await store.append("run_failed", {
      code: "JOB_CANCELLED_WITHOUT_ACTIVE_RUNTIME",
      message: `Job '${jobId}' was marked ambiguous because no active owner could confirm termination.`,
      stage: "job_cancellation",
    });
  }
  await store.snapshot();
  return { runId, jobId, outcome: "ambiguous" };
}

async function resolvedRoutingConfig(
  options: CueLineRuntimeOptions,
  environment: NodeJS.ProcessEnv,
): Promise<RoutingConfig> {
  return (
    options.routingConfig ??
    (await loadRoutingConfig(routingConfigPath(environment, options.routingConfigPath)))
  );
}

function registryFor(config: RoutingConfig): RunnerRegistry {
  const executables = new Set<string>();
  for (const lane of Object.values(config.lanes)) {
    for (const candidate of lane.candidates) {
      const executable = candidate.argv[0];
      if (candidate.enabled !== false && executable !== undefined) executables.add(executable);
    }
  }
  return new RunnerRegistry(
    [...executables].map((executable) => ({ id: executable, executable })),
  );
}

function routingInstruction(
  config: RoutingConfig,
  availability: ReturnType<typeof executableAvailability>,
): string {
  const lanes = Object.entries(config.lanes)
    .filter(([, lane]) => lane.enabled)
    .map(([name, lane]) => {
      const candidates = lane.candidates
        .filter(
          (candidate) =>
            candidate.enabled !== false && availability.isAvailable(candidate, name),
        )
        .map((candidate) => candidate.id);
      return `${name} [${candidates.length > 0 ? candidates.join(", ") : "unavailable"}]`;
    });
  return `Available routing lanes: ${lanes.join("; ")}. Use only a listed lane. Select an optional candidate with the field runner; never use runner_id or place a runner ID in lane.`;
}

async function prepareRuntime(
  options: CueLineRuntimeOptions,
  persistedConversationUrl?: string,
): Promise<PreparedRuntime> {
  const environment = options.environment ?? runtimeEnvironment();
  const home = options.home ?? defaultCueLineHome(environment);
  const cwd = options.cwd ?? runtimeCwd();
  const config = await resolvedRoutingConfig(options, environment);
  const availability = executableAvailability(environment, cwd);
  const registry = registryFor(config);
  const runner = new ProcessRunner(registry, { environment });
  const jobSupervisor = new JobSupervisor(runner, {
    statusStore: new JobStatusStore(home),
  });
  const conversationUrl = options.conversationUrl ?? persistedConversationUrl;
  const browser =
    options.browser ??
    createCodexIabAdapter({
      ...options.browserOptions,
      ...(conversationUrl === undefined ? {} : { conversationUrl }),
    });

  return {
    browser,
    jobSupervisor,
    resolveRunnerSpec(jobId, job) {
      const route = resolveRoute(job.lane, config, availability, job.runner);
      return materializeRunnerSpec(jobId, job, route, {
        cwd,
        ...(options.defaultTimeoutMs === undefined
          ? {}
          : { timeoutMs: options.defaultTimeoutMs }),
      });
    },
    controllerInstructions: [routingInstruction(config, availability)],
    ...(conversationUrl === undefined ? {} : { conversationUrl }),
    home,
  };
}

export async function startCueLineRun(
  options: StartCueLineRunOptions,
): Promise<CueLineResult> {
  assertNotNested(options.environment ?? runtimeEnvironment());
  const runtime = await prepareRuntime(options);
  return runControllerLoop({
    request: options.request,
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    ...runtime,
    ...(options.maxRounds === undefined ? {} : { maxRounds: options.maxRounds }),
    ...(options.maxRepairAttempts === undefined
      ? {}
      : { maxRepairAttempts: options.maxRepairAttempts }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.cancellationPollIntervalMs === undefined
      ? {}
      : { cancellationPollIntervalMs: options.cancellationPollIntervalMs }),
    ...(options.runTimeoutMs === undefined ? {} : { runTimeoutMs: options.runTimeoutMs }),
  });
}

export async function runCueLine(options: StartCueLineRunOptions): Promise<CueLineResult> {
  return startCueLineRun(options);
}

export async function continueCueLineRun(
  options: ContinueCueLineRunOptions,
): Promise<CueLineResult> {
  const environment = options.environment ?? runtimeEnvironment();
  const home = options.home ?? defaultCueLineHome(environment);
  const state = await persistedRunState(home, options.runId);
  if (isTerminalRun(state)) {
    return terminalResult(state);
  }
  assertRunCanContinue(
    state,
    await readRuntimeLease(home, options.runId, {
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
    await readCancellationObservation(home, options.runId),
  );
  assertNotNested(environment);
  const runtime = await prepareRuntime(options, state.conversationUrl ?? undefined);
  return continueControllerLoop({
    runId: options.runId,
    ...runtime,
    ...(options.reconcileRequestId === undefined
      ? {}
      : { reconcileRequestId: options.reconcileRequestId }),
    ...(options.abandonOtherPendingTurns === undefined
      ? {}
      : { abandonOtherPendingTurns: options.abandonOtherPendingTurns }),
    ...(options.maxRounds === undefined ? {} : { maxRounds: options.maxRounds }),
    ...(options.maxRepairAttempts === undefined
      ? {}
      : { maxRepairAttempts: options.maxRepairAttempts }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.cancellationPollIntervalMs === undefined
      ? {}
      : { cancellationPollIntervalMs: options.cancellationPollIntervalMs }),
    ...(options.runTimeoutMs === undefined ? {} : { runTimeoutMs: options.runTimeoutMs }),
  });
}

export { createCodexIabAdapter };
export { CUELINE_VERSION } from "./version.js";
export type {
  BrowserAdapter,
  CueLineResult,
  CueLineRunState,
  CueLineRunStatusSummary,
  RoutingConfig,
};
