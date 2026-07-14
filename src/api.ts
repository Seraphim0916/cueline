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
import { defaultCueLineHome } from "./state/paths.js";
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

async function persistedRunState(home: string, runId: string): Promise<CueLineRunState> {
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
  return state;
}

function terminalResult(state: CueLineRunState): CueLineResult {
  if (state.status !== "complete" && state.status !== "blocked") {
    throw new CueLineError("RUN_NOT_TERMINAL", "CueLine result requested before a terminal state.");
  }
  return {
    runId: state.runId,
    status: state.status,
    ...(state.finalDeliveryText === null ? {} : { finalDeliveryText: state.finalDeliveryText }),
    ...(state.conversationUrl === null ? {} : { conversationUrl: state.conversationUrl }),
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
  return `Available routing lanes: ${lanes.join("; ")}. Use only a listed available lane and optional runner id.`;
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
  if (state.status === "complete" || state.status === "blocked") {
    return terminalResult(state);
  }
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
  });
}

export { createCodexIabAdapter };
export type { BrowserAdapter, CueLineResult, CueLineRunState, RoutingConfig };
