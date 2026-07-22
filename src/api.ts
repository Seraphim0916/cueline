import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ContinueCueLineRunOptions,
  CueLineRuntimeOptions,
  StartCueLineRunOptions,
} from "./api-contracts.js";
import {
  confirmControllerTurnMisdirected,
  confirmControllerTurnNotSent,
  confirmManualControllerSubmission,
  reauthorizeControllerPostFixRetry,
} from "./api-controller-handoff.js";
import { verifyCueLineRun } from "./api-run-verification.js";
import {
  claimCueLineCallerJob,
  heartbeatCueLineCallerJob,
  reconcileExpiredCallerWorkClaims,
  releaseCueLineCallerJob,
  startCueLineCallerJob,
} from "./api-caller-work.js";
import {
  isTerminalRun,
  reconcileCueLineRuntime,
  terminalResult,
} from "./api-runtime-lifecycle.js";
import type { BrowserAdapter } from "./browser/browser-adapter.js";
import { createCodexIabAdapter } from "./browser/codex-iab/chatgpt-client.js";
import { assertBrowserAdapterContract } from "./browser/validate-browser-adapter.js";
import { probeCodexIab } from "./browser/codex-iab/probe.js";
import {
  continueControllerLoop,
  createControllerRun,
  runControllerLoop,
  validateControllerRuntimeOptions,
  type CueLineResult,
} from "./core/controller-loop.js";
import { controllerConversationArchiveNeedsRecovery } from "./core/controller-conversation-archive.js";
import { sameChatGptConversationUrl } from "./core/conversation-url.js";
import { CueLineError } from "./core/errors.js";
import {
  loadPersistedRunState,
  loadPersistedRunStore,
} from "./core/persisted-run.js";
import { runtimeCwd, runtimeEnvironment } from "./core/runtime.js";
import { validatedTimerDelay } from "./core/timing.js";
import {
  assertRunCanContinue,
  isSafeStaleCallerObservationRecovery,
  type CueLineRunStatusSummary,
} from "./core/run-status.js";
import type { CueLineRunState } from "./core/state-machine.js";
import { JobStatusStore } from "./jobs/status.js";
import { JobSupervisor } from "./jobs/supervisor.js";
import type { ControllerJobSpec } from "./protocol/types.js";
import { executableAvailability } from "./router/availability.js";
import { loadRoutingConfig, parseRoutingConfig } from "./router/config-loader.js";
import { materializeRunnerSpec } from "./router/materialize.js";
import { resolveRoute, validateRouteReference } from "./router/resolver.js";
import type { RoutingConfig } from "./router/types.js";
import { ProcessRunner } from "./runners/process-runner.js";
import { RunnerRegistry } from "./runners/registry.js";
import { readCancellationObservation } from "./state/cancellation.js";
import { defaultCueLineHome } from "./state/paths.js";
import {
  readRuntimeLease,
  retireDeadRuntimeLease,
  RuntimeLease,
} from "./state/runtime-lease.js";

interface PreparedRuntime {
  browser: BrowserAdapter;
  jobSupervisor: JobSupervisor;
  validateJobSpec: (job: ControllerJobSpec) => void;
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

async function resolvedRoutingConfig(
  options: CueLineRuntimeOptions,
  environment: NodeJS.ProcessEnv,
): Promise<RoutingConfig> {
  return options.routingConfig === undefined
    ? loadRoutingConfig(routingConfigPath(environment, options.routingConfigPath))
    : parseRoutingConfig(options.routingConfig);
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
  executor: "caller" | "process",
): string {
  if (executor === "caller") {
    const lanes = Object.entries(config.lanes)
      .filter(([, lane]) => lane.enabled)
      .map(([name]) => name);
    return `Caller execution lanes: ${lanes.join(", ")}. Use only a listed lane with mode advise or work. The current Codex executes each task after handoff. Every work job must include the exact absolute workdir. CueLine only records work as pending until the current Codex explicitly claims and starts it; dispatch does not mean local work has begun. Do not select runner or runner_id. The web controller has no local tools. Local inspection tasks must return exact code or error identifiers, relevant code excerpts, and absolute local paths; request any missing local evidence explicitly.`;
  }
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
  return `Available routing lanes: ${lanes.join("; ")}. Use only a listed lane. Select an optional candidate with the field runner; never use runner_id or place a runner ID in lane. If you provide workdir, it must be an absolute path; omit it to use the workspace bound by the local runtime.`;
}

async function prepareRuntime(
  options: CueLineRuntimeOptions,
  persistedConversationUrl?: string,
  persistedExecutor?: "caller" | "process",
): Promise<PreparedRuntime> {
  const environment = options.environment ?? runtimeEnvironment();
  const home = options.home ?? defaultCueLineHome(environment);
  const cwd = path.resolve(options.cwd ?? runtimeCwd());
  const executor = persistedExecutor ?? options.executor ?? "caller";
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
  assertBrowserAdapterContract(browser);

  return {
    browser,
    jobSupervisor,
    validateJobSpec(job) {
      validateRouteReference(job.lane, config, job.runner);
      if (executor === "process") {
        if (job.workdir !== undefined && !path.isAbsolute(job.workdir)) {
          throw new CueLineError(
            "PROCESS_WORKDIR_ABSOLUTE_REQUIRED",
            "Process jobs must use an absolute workdir; omit workdir to bind the run's current workspace.",
          );
        }
        job.workdir = path.resolve(job.workdir ?? cwd);
      }
    },
    resolveRunnerSpec(jobId, job) {
      const jobAvailability =
        job.workdir === undefined || job.workdir === cwd
          ? availability
          : executableAvailability(environment, job.workdir);
      const route = resolveRoute(job.lane, config, jobAvailability, job.runner);
      return materializeRunnerSpec(jobId, job, route, {
        cwd,
        ...(options.defaultTimeoutMs === undefined
          ? {}
          : { timeoutMs: options.defaultTimeoutMs }),
      });
    },
    controllerInstructions: [
      routingInstruction(config, availability, executor),
    ],
    ...(conversationUrl === undefined ? {} : { conversationUrl }),
    home,
  };
}

function validateDefaultProcessTimeout(options: CueLineRuntimeOptions): void {
  if (options.defaultTimeoutMs === undefined) return;
  validatedTimerDelay(options.defaultTimeoutMs, {
    code: "PROCESS_TIMEOUT_INVALID",
    name: "defaultTimeoutMs",
  });
}

export async function startCueLineRun(
  options: StartCueLineRunOptions,
): Promise<CueLineResult> {
  assertNotNested(options.environment ?? runtimeEnvironment());
  return createControllerRun({
    request: options.request,
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    home: options.home ?? defaultCueLineHome(options.environment ?? runtimeEnvironment()),
    executor: options.executor ?? "caller",
    ...(options.allowProcessExecution === undefined
      ? {}
      : { allowProcessExecution: options.allowProcessExecution }),
    ...(options.maxRounds === undefined ? {} : { maxRounds: options.maxRounds }),
    ...(options.maxJobEvidenceChars === undefined
      ? {}
      : { maxJobEvidenceChars: options.maxJobEvidenceChars }),
    ...(options.maxRepairAttempts === undefined
      ? {}
      : { maxRepairAttempts: options.maxRepairAttempts }),
    ...(options.archiveControllerConversationOnComplete === undefined
      ? {}
      : {
          archiveControllerConversationOnComplete:
            options.archiveControllerConversationOnComplete,
        }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

export async function runCueLine(options: StartCueLineRunOptions): Promise<CueLineResult> {
  if (options.browser !== undefined) assertBrowserAdapterContract(options.browser);
  assertNotNested(options.environment ?? runtimeEnvironment());
  validateControllerRuntimeOptions(options);
  validateDefaultProcessTimeout(options);
  const runtime = await prepareRuntime(options);
  return runControllerLoop({
    request: options.request,
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    ...runtime,
    executor: options.executor ?? "caller",
    ...(options.allowProcessExecution === undefined
      ? {}
      : { allowProcessExecution: options.allowProcessExecution }),
    ...(options.archiveControllerConversationOnComplete === undefined
      ? {}
      : {
          archiveControllerConversationOnComplete:
            options.archiveControllerConversationOnComplete,
        }),
    returnAfterControllerSubmission: (options.executor ?? "caller") === "caller",
    ...(options.maxRounds === undefined ? {} : { maxRounds: options.maxRounds }),
    ...(options.maxJobEvidenceChars === undefined
      ? {}
      : { maxJobEvidenceChars: options.maxJobEvidenceChars }),
    ...(options.maxRepairAttempts === undefined
      ? {}
      : { maxRepairAttempts: options.maxRepairAttempts }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.cancellationPollIntervalMs === undefined
      ? {}
      : { cancellationPollIntervalMs: options.cancellationPollIntervalMs }),
    ...(options.runTimeoutMs === undefined ? {} : { runTimeoutMs: options.runTimeoutMs }),
    ...(options.maxConcurrency === undefined
      ? {}
      : { maxConcurrency: options.maxConcurrency }),
    ...(options.laneConcurrency === undefined
      ? {}
      : { laneConcurrency: options.laneConcurrency }),
  });
}

export async function continueCueLineRun(
  options: ContinueCueLineRunOptions,
): Promise<CueLineResult> {
  if (options.browser !== undefined) assertBrowserAdapterContract(options.browser);
  const environment = options.environment ?? runtimeEnvironment();
  const home = options.home ?? defaultCueLineHome(environment);
  if (options.manualSendConfirmed === true && options.reconcileRequestId === undefined) {
    throw new CueLineError(
      "CONTROLLER_RECONCILIATION_REQUEST_REQUIRED",
      "manualSendConfirmed requires the exact reconcileRequestId.",
    );
  }
  let state = await loadPersistedRunState(home, options.runId);
  if (
    options.archiveControllerConversationOnComplete !== undefined &&
    options.archiveControllerConversationOnComplete !==
      (state.controllerConversationArchive?.enabled ?? false)
  ) {
    throw new CueLineError(
      "CONTROLLER_CONVERSATION_ARCHIVE_POLICY_MISMATCH",
      `Run '${options.runId}' has a different durable controller conversation archive policy.`,
    );
  }
  if (
    options.conversationUrl !== undefined &&
    state.conversationUrl !== null &&
    !sameChatGptConversationUrl(options.conversationUrl, state.conversationUrl)
  ) {
    throw new CueLineError(
      "CONTROLLER_RECONCILIATION_CONVERSATION_MISMATCH",
      `Run '${options.runId}' is already bound to a different ChatGPT conversation.`,
    );
  }
  let recoverControllerArchive = controllerConversationArchiveNeedsRecovery(state);
  if (
    isTerminalRun(state) &&
    !recoverControllerArchive &&
    options.manualSendConfirmed !== true
  ) {
    return terminalResult(state);
  }
  let preparedRuntime: PreparedRuntime | undefined;
  if (options.manualSendConfirmed === true) {
    assertNotNested(environment);
    validateControllerRuntimeOptions(options);
    validateDefaultProcessTimeout(options);
    if (options.executor !== undefined && options.executor !== state.executor) {
      throw new CueLineError(
        "RUN_EXECUTOR_MISMATCH",
        `Run '${options.runId}' uses executor '${state.executor}', not '${options.executor}'.`,
      );
    }
    if (
      state.executor === "process" &&
      (!state.allowProcessExecution || options.allowProcessExecution !== true)
    ) {
      throw new CueLineError(
        "PROCESS_EXECUTION_NOT_AUTHORIZED",
        "Continuing a process run requires allowProcessExecution=true in addition to its persisted authorization.",
      );
    }
    if (!isTerminalRun(state)) {
      preparedRuntime = await prepareRuntime(
        options,
        state.conversationUrl ?? undefined,
        state.executor,
      );
    }
    await confirmManualControllerSubmission(options.runId, {
      home,
      requestId: options.reconcileRequestId!,
      ...(options.conversationUrl === undefined
        ? {}
        : { conversationUrl: options.conversationUrl }),
    });
    state = await loadPersistedRunState(home, options.runId);
    recoverControllerArchive = controllerConversationArchiveNeedsRecovery(state);
  }
  if (isTerminalRun(state) && !recoverControllerArchive) {
    return terminalResult(state);
  }
  let runtime = await readRuntimeLease(home, options.runId, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (
    (runtime.ownership === "active" || runtime.ownership === "stale") &&
    runtime.ownerId !== undefined &&
    (await retireDeadRuntimeLease(home, options.runId, runtime.ownerId))
  ) {
    const recoveryLease = await RuntimeLease.claim({
      home,
      runId: options.runId,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    try {
      const recoveryStore = await loadPersistedRunStore(home, options.runId);
      recoveryStore.bindRuntimeOwner(recoveryLease.ownerId);
      await recoveryStore.append("runtime_dead_owner_retired", {
        owner_id: runtime.ownerId,
        previous_ownership: runtime.ownership,
      });
      await recoveryStore.snapshot();
      state = recoveryStore.state;
    } finally {
      await recoveryLease.release();
    }
    runtime = await readRuntimeLease(home, options.runId, {
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }
  const callerHasActiveJobs =
    state.executor === "caller" &&
    Object.values(state.jobs).some(
      (job) => job.status === "pending" || job.status === "running",
    );
  if (
    callerHasActiveJobs &&
    (runtime.ownership === "missing" || runtime.ownership === "released")
  ) {
    await reconcileExpiredCallerWorkClaims(options.runId, {
      home,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    state = await loadPersistedRunState(home, options.runId);
    runtime = await readRuntimeLease(home, options.runId, {
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }
  const hasActiveJobs = Object.values(state.jobs).some(
    (job) => job.status === "pending" || job.status === "running",
  );
  if (state.executor === "process" && runtime.ownership !== "active" && hasActiveJobs) {
    const reconciled = await reconcileCueLineRuntime(options.runId, {
      home,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    if (reconciled.outcome === "processes_alive") {
      throw new CueLineError(
        "RUNTIME_WORKERS_STILL_ALIVE",
        `Run '${options.runId}' has ownerless worker processes still alive; refusing takeover.`,
        { details: { job_ids: reconciled.survivingJobs } },
      );
    }
    state = await loadPersistedRunState(home, options.runId);
    runtime = await readRuntimeLease(home, options.runId, {
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }
  const cancellation = await readCancellationObservation(home, options.runId);
  if (
    !recoverControllerArchive &&
    !isSafeStaleCallerObservationRecovery(state, runtime, cancellation)
  ) {
    assertRunCanContinue(state, runtime, cancellation);
  }
  if (preparedRuntime === undefined) {
    assertNotNested(environment);
    if (options.executor !== undefined && options.executor !== state.executor) {
      throw new CueLineError(
        "RUN_EXECUTOR_MISMATCH",
        `Run '${options.runId}' uses executor '${state.executor}', not '${options.executor}'.`,
      );
    }
    if (
      !recoverControllerArchive &&
      state.executor === "process" &&
      (!state.allowProcessExecution || options.allowProcessExecution !== true)
    ) {
      throw new CueLineError(
        "PROCESS_EXECUTION_NOT_AUTHORIZED",
        "Continuing a process run requires allowProcessExecution=true in addition to its persisted authorization.",
      );
    }
    validateControllerRuntimeOptions(options);
    validateDefaultProcessTimeout(options);
    preparedRuntime = await prepareRuntime(
      options,
      state.conversationUrl ?? undefined,
      state.executor,
    );
  }
  return continueControllerLoop({
    runId: options.runId,
    ...preparedRuntime,
    executor: state.executor,
    ...(state.executor === "process" ? { allowProcessExecution: true } : {}),
    archiveControllerConversationOnComplete:
      state.controllerConversationArchive?.enabled === true,
    returnAfterControllerSubmission: state.executor === "caller",
    returnAfterRecoveredControllerResponse: state.executor === "caller",
    ...(options.reconcileRequestId === undefined
      ? {}
      : { reconcileRequestId: options.reconcileRequestId }),
    ...(options.abandonOtherPendingTurns === undefined
      ? {}
      : { abandonOtherPendingTurns: options.abandonOtherPendingTurns }),
    ...(options.maxRounds === undefined ? {} : { maxRounds: options.maxRounds }),
    ...(options.maxJobEvidenceChars === undefined
      ? {}
      : { maxJobEvidenceChars: options.maxJobEvidenceChars }),
    ...(options.maxRepairAttempts === undefined
      ? {}
      : { maxRepairAttempts: options.maxRepairAttempts }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.cancellationPollIntervalMs === undefined
      ? {}
      : { cancellationPollIntervalMs: options.cancellationPollIntervalMs }),
    ...(options.runTimeoutMs === undefined ? {} : { runTimeoutMs: options.runTimeoutMs }),
    ...(options.maxConcurrency === undefined
      ? {}
      : { maxConcurrency: options.maxConcurrency }),
    ...(options.laneConcurrency === undefined
      ? {}
      : { laneConcurrency: options.laneConcurrency }),
  });
}

export {
  confirmManualControllerSubmission,
  confirmControllerTurnMisdirected,
  confirmControllerTurnNotSent,
  reauthorizeControllerPostFixRetry,
  submitCueLineCallerJobResult,
} from "./api-controller-handoff.js";
export {
  claimCueLineCallerJob,
  heartbeatCueLineCallerJob,
  releaseCueLineCallerJob,
  startCueLineCallerJob,
};
export {
  cancelCueLineJob,
  cancelCueLineRun,
  listCueLineRuns,
  loadCueLineRunState,
  loadCueLineRunStatus,
  reconcileCueLineRuntime,
  takeoverCueLineRuntime,
} from "./api-runtime-lifecycle.js";
export {
  PRUNABLE_RUN_STATES,
  pruneCueLineRuns,
  type CueLineRunPruneDecision,
  type CueLineRunPruneError,
  type CueLineRunPruneKeptReason,
  type CueLineRunPruneOptions,
  type CueLineRunPruneResult,
  type PrunableRunState,
} from "./api-run-prune.js";
export {
  diagnoseCueLineRun,
  diagnoseCueLineRunStatus,
} from "./diagnostics/run-doctor.js";
export {
  auditCueLineRunSecrets,
  SECRET_AUDIT_PROTOCOL,
  type CueLineSecretAuditReport,
  type CueLineSecretFinding,
  type SecretFindingKind,
} from "./diagnostics/secret-audit.js";
export { verifyCueLineRun };
export { createCodexIabAdapter, probeCodexIab };
export { waitForCueLineRunChange } from "./observation/run-watch.js";
export { lintControllerCommandText } from "./protocol/lint-command.js";
export { explainRoutingConfig } from "./router/explain.js";
export {
  buildCueLineRunHandoff,
  createCueLineRunHandoff,
  renderCueLineRunHandoffMarkdown,
} from "./observation/run-handoff.js";
export {
  buildCueLineRunTimeline,
  loadCueLineRunTimeline,
} from "./observation/run-timeline.js";
export { loadCueLineRunStatusAt } from "./observation/run-status-at.js";
export {
  buildCueLineRunSupportBundle,
  RUN_BUNDLE_PROTOCOL,
  type CueLineRunSupportBundle,
  type CueLineRunSupportBundleOptions,
} from "./observation/run-bundle.js";
export { compareCueLineRuns } from "./observation/run-diff.js";
export {
  buildCueLineRunGraph,
  loadCueLineRunGraph,
} from "./observation/run-graph.js";
export { CUELINE_VERSION } from "./version.js";
export type {
  ContinueCueLineRunOptions,
  CueLineCallerJobResultInput,
  CueLineCallerJobSubmissionOptions,
  CueLineCallerJobSubmissionResult,
  CueLineCallerWorkClaimOptions,
  CueLineCallerWorkClaimProof,
  CueLineCallerWorkClaimResult,
  CueLineCallerWorkMutationOptions,
  CueLineCallerWorkMutationResult,
  CueLineJobCancellationResult,
  CueLineRunListEntry,
  CueLineRunCancellationResult,
  CueLineRunVerificationFinding,
  CueLineRunVerificationOutcome,
  CueLineRunVerificationReport,
  CueLineRuntimeOptions,
  CueLineRuntimeReconciliationResult,
  CueLineRuntimeTakeoverResult,
  ManualControllerSubmissionConfirmation,
  StartCueLineRunOptions,
} from "./api-contracts.js";
export type {
  CueLineDiagnosticSeverity,
  CueLineRunDiagnosis,
  CueLineRunDiagnosticFinding,
  CueLineRunDiagnosticOutcome,
} from "./diagnostics/run-doctor.js";
export type {
  CueLineRunWatchOptions,
  CueLineRunWatchResult,
} from "./observation/run-watch.js";
export type {
  CueLineProtocolLintIssue,
  CueLineProtocolLintOptions,
  CueLineProtocolLintResult,
  CueLineProtocolLintRouting,
  CueLineProtocolLintSeverity,
} from "./protocol/lint-command.js";
export type {
  RoutingCandidateExplanation,
  RoutingCandidateReasonCode,
  RoutingExplanation,
  RoutingLaneExplanation,
} from "./router/explain.js";
export type {
  CueLineRunHandoffBuildOptions,
  CueLineRunHandoffContent,
  CueLineRunHandoffOptions,
  CueLineRunHandoffPacket,
} from "./observation/run-handoff.js";
export type {
  CueLineRunTimeline,
  CueLineRunTimelineEntry,
  CueLineRunTimelineOptions,
  CueLineTimelineCategory,
} from "./observation/run-timeline.js";
export type {
  CueLineRunStatusAt,
  CueLineRunStatusAtOptions,
} from "./observation/run-status-at.js";
export type {
  CueLineRunDiff,
  CueLineRunDiffChange,
  CueLineRunDiffOptions,
  CueLineRunDiffProjection,
} from "./observation/run-diff.js";
export type {
  CueLineRunGraph,
  CueLineRunGraphOptions,
} from "./observation/run-graph.js";
export type {
  CodexIabBrowserSource,
  CodexIabPageProbe,
  CodexIabProbeOptions,
  CodexIabProbeResult,
  CodexIabProbeStatus,
  CodexIabTabSource,
} from "./browser/codex-iab/probe.js";
export type {
  BrowserAdapter,
  CueLineResult,
  CueLineRunState,
  CueLineRunStatusSummary,
  RoutingConfig,
};
