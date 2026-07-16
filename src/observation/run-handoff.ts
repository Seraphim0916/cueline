import { createHash } from "node:crypto";

import type { CueLineRuntimeOptions } from "../api-contracts.js";
import { loadCueLineRunStatus } from "../api-runtime-lifecycle.js";
import { CueLineError } from "../core/errors.js";
import { jobSpecHash } from "../core/ids.js";
import { loadPersistedRunStore } from "../core/persisted-run.js";
import type {
  CueLineRunStatusSummary,
  CueLineSafeNextAction,
} from "../core/run-status.js";
import type { CueLineRunState } from "../core/state-machine.js";
import { defaultCueLineHome, runPaths } from "../state/paths.js";

const DEFAULT_MAX_CONTENT_CHARS = 2_000;
const MIN_MAX_CONTENT_CHARS = 16;
const MAX_MAX_CONTENT_CHARS = 10_000;

export interface CueLineRunHandoffContent {
  request: string;
  tasks: Record<string, string>;
  finalDeliveryText?: string;
  blockedReason?: string;
}

export interface CueLineRunHandoffPacket {
  schema: "cueline-handoff/0.1";
  generatedAt: string;
  contentPolicy: "metadata_only" | "bounded_request_and_tasks";
  run: {
    runId: string;
    requestHash: string;
    status: CueLineRunState["status"];
    executor: CueLineRunState["executor"];
    phase: CueLineRunStatusSummary["phase"];
    round: number;
    maxRounds: number;
    eventSequence: number;
    continueAllowed: boolean;
    safeNextAction: CueLineSafeNextAction;
  };
  paths: {
    home: string;
    runDir: string;
    events: string;
    snapshot: string;
    runtimeLease: string;
  };
  conversation: {
    url: string | null;
    responseAccepted: boolean;
    lastAcceptedAction: CueLineRunStatusSummary["controller"]["lastAcceptedAction"];
    lastAcceptedRequestId: string | null;
    archive: CueLineRunStatusSummary["controller"]["archive"];
  };
  pendingControllerTurns: Array<{
    requestId: string;
    round: number;
    submissionState: string;
    conversationUrl: string | null;
    manualSendConfirmed: boolean;
    promptHash: string;
    selectedModelLabel: string | null;
    composerPromptState: "inline_ready" | "attachment_ready" | null;
    submissionCheckpointContract: "write_ahead_v1" | null;
  }>;
  jobs: Array<{
    jobId: string;
    jobKey: string;
    required: boolean;
    lane: string;
    mode: string;
    status: string;
    taskHash: string;
    workdir?: string;
    claimed?: boolean;
    started?: boolean;
  }>;
  lastFailure: null | {
    code: string;
    stage: string | null;
    submissionState: string | null;
    requestId: string | null;
    conversationUrl: string | null;
  };
  next: {
    action: CueLineSafeNextAction;
    instruction: string;
    apiExample: string;
  };
  content?: CueLineRunHandoffContent;
}

export interface CueLineRunHandoffBuildOptions {
  includeContent?: boolean;
  maxContentChars?: number;
  now?: () => Date;
}

export interface CueLineRunHandoffOptions
  extends Pick<CueLineRuntimeOptions, "home" | "environment" | "now">,
    Pick<CueLineRunHandoffBuildOptions, "includeContent" | "maxContentChars"> {}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function maxContentChars(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_CONTENT_CHARS;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < MIN_MAX_CONTENT_CHARS ||
    resolved > MAX_MAX_CONTENT_CHARS
  ) {
    throw new CueLineError(
      "RUN_HANDOFF_OPTIONS_INVALID",
      `maxContentChars must be an integer from ${MIN_MAX_CONTENT_CHARS} to ${MAX_MAX_CONTENT_CHARS}.`,
    );
  }
  return resolved;
}

function bounded(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const marker = "[truncated]";
  if (maximum <= marker.length) return marker.slice(0, maximum);
  return `${value.slice(0, Math.max(0, maximum - marker.length))}${marker}`;
}

function nextStep(
  runId: string,
  action: CueLineSafeNextAction,
  jobs: CueLineRunHandoffPacket["jobs"],
): CueLineRunHandoffPacket["next"] {
  const active = (job: CueLineRunHandoffPacket["jobs"][number]) =>
    job.status === "pending" || job.status === "running";
  const firstJob =
    action === "claim_caller_work"
      ? jobs.find((job) => active(job) && job.mode === "work" && job.claimed !== true)
      : action === "start_caller_work"
        ? jobs.find(
            (job) => active(job) && job.mode === "work" && job.claimed === true && job.started !== true,
          )
        : action === "continue_caller_work"
          ? jobs.find(
              (job) => active(job) && job.mode === "work" && job.started === true,
            )
          : action === "execute_caller_jobs"
            ? jobs.find((job) => active(job) && job.mode === "advise")
            : jobs.find(active);
  const jobId = firstJob?.jobId ?? "<job-id>";
  const shared = {
    action,
    instruction: "Inspect the persisted run before acting. Pro has no local tools.",
    apiExample: `await continueCueLineRun({ runId: ${JSON.stringify(runId)}, browser });`,
  };
  switch (action) {
    case "observe":
      return {
        action,
        instruction: "Observe the exact persisted controller turn; do not resend or interrupt Pro.",
        apiExample: shared.apiExample,
      };
    case "retry":
      return {
        action,
        instruction: "Durable evidence proves the same turn was not sent; retry only that turn.",
        apiExample: shared.apiExample,
      };
    case "reconcile":
      return {
        action,
        instruction: "Reconcile exact conversation, model, round, and request identity; never resend.",
        apiExample: `await confirmManualControllerSubmission(${JSON.stringify(runId)}, { requestId: "<request-id>", conversationUrl: "https://chatgpt.com/c/..." });`,
      };
    case "execute_caller_jobs":
      return {
        action,
        instruction: "The current Codex must execute each caller advice job locally and submit terminal evidence.",
        apiExample: `await submitCueLineCallerJobResult(${JSON.stringify(runId)}, ${JSON.stringify(jobId)}, result);`,
      };
    case "claim_caller_work":
      return {
        action,
        instruction: "Pro only proposed the work. Claim the exact caller work job before modifying files.",
        apiExample: `await claimCueLineCallerJob(${JSON.stringify(runId)}, ${JSON.stringify(jobId)}, { callerId: "<current-codex>" });`,
      };
    case "start_caller_work":
      return {
        action,
        instruction: "Verify the existing claim proof, then durably start that exact claim before mutation.",
        apiExample: `await startCueLineCallerJob(${JSON.stringify(runId)}, ${JSON.stringify(jobId)}, claimProof);`,
      };
    case "continue_caller_work":
      return {
        action,
        instruction: "Work may already have side effects. Continue only the existing started claim; never retry automatically.",
        apiExample: `await heartbeatCueLineCallerJob(${JSON.stringify(runId)}, ${JSON.stringify(jobId)}, claimProof);`,
      };
    case "inspect_runtime":
      return {
        action,
        instruction: "Inspect owner and worker liveness before takeover or reconciliation.",
        apiExample: `cueline run status ${runId} --json`,
      };
    case "inspect_jobs_then_continue":
      return {
        action,
        instruction: "Resolve every active-looking job from durable and process evidence before continuing.",
        apiExample: `cueline jobs --json`,
      };
    case "settle_controller_archive":
      return {
        action,
        instruction:
          "Settle the durable post-completion archive state once. A started attempt must become ambiguous; never click Archive again.",
        apiExample: shared.apiExample,
      };
    case "return_result":
      return {
        action,
        instruction: "The run is terminal. Return its persisted result without continuing it.",
        apiExample: `await loadCueLineRunState(${JSON.stringify(runId)});`,
      };
    case "continue":
    default:
      return shared;
  }
}

export function buildCueLineRunHandoff(
  state: CueLineRunState,
  status: CueLineRunStatusSummary,
  home: string,
  options: CueLineRunHandoffBuildOptions = {},
): CueLineRunHandoffPacket {
  if (state.runId !== status.runId) {
    throw new CueLineError(
      "RUN_HANDOFF_ID_MISMATCH",
      "Run state and status belong to different runs.",
    );
  }
  const maximum = maxContentChars(options.maxContentChars);
  const paths = runPaths(home, state.runId);
  const statusJobs = new Map(status.jobs.items.map((job) => [job.jobId, job]));
  const jobs = Object.values(state.jobs).map((job) => {
    const observed = statusJobs.get(job.jobId);
    const claim = job.callerWork?.claim;
    return {
      jobId: job.jobId,
      jobKey: job.jobKey,
      required: job.required,
      lane: job.spec.lane,
      mode: job.spec.mode,
      status: observed?.status ?? job.status,
      taskHash: jobSpecHash(job.spec),
      ...(job.spec.workdir === undefined ? {} : { workdir: job.spec.workdir }),
      ...(job.spec.mode !== "work"
        ? {}
        : {
            claimed: claim !== null && claim !== undefined,
            started: claim?.startedAt !== null && claim?.startedAt !== undefined,
          }),
    };
  });
  const packet: CueLineRunHandoffPacket = {
    schema: "cueline-handoff/0.1",
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    contentPolicy: options.includeContent === true
      ? "bounded_request_and_tasks"
      : "metadata_only",
    run: {
      runId: state.runId,
      requestHash: sha256(state.request),
      status: state.status,
      executor: state.executor,
      phase: status.phase,
      round: state.round,
      maxRounds: state.maxRounds,
      eventSequence: status.lastEventSequence,
      continueAllowed: status.continueAllowed,
      safeNextAction: status.safeNextAction,
    },
    paths: {
      home: paths.home,
      runDir: paths.runDir,
      events: paths.events,
      snapshot: paths.snapshot,
      runtimeLease: paths.runtimeLease,
    },
    conversation: {
      url: state.conversationUrl,
      responseAccepted: status.controller.responseAccepted,
      lastAcceptedAction: status.controller.lastAcceptedAction,
      lastAcceptedRequestId: status.controller.lastAcceptedRequestId,
      archive: { ...status.controller.archive },
    },
    pendingControllerTurns: state.pendingControllerTurns.map((turn) => ({
      requestId: turn.requestId,
      round: turn.round,
      submissionState: turn.submissionState,
      conversationUrl: turn.conversationUrl,
      manualSendConfirmed: turn.manualSendConfirmed,
      promptHash: turn.promptHash,
      selectedModelLabel: turn.selectedModelLabel,
      composerPromptState: turn.composerPromptState,
      submissionCheckpointContract: turn.submissionCheckpointContract ?? null,
    })),
    jobs,
    lastFailure:
      state.lastFailure === null
        ? null
        : {
            code: state.lastFailure.code,
            stage: state.lastFailure.stage,
            submissionState: state.lastFailure.submissionState,
            requestId: state.lastFailure.requestId,
            conversationUrl: state.lastFailure.conversationUrl,
          },
    next: nextStep(state.runId, status.safeNextAction, jobs),
  };
  if (options.includeContent === true) {
    const trailing = [
      ...Object.values(state.jobs).map((job) => ({
        kind: "task" as const,
        key: job.jobId,
        value: job.spec.task,
      })),
      ...(state.finalDeliveryText === null
        ? []
        : [{ kind: "final" as const, key: "final", value: state.finalDeliveryText }]),
      ...(state.blockedReason === null
        ? []
        : [{ kind: "blocked" as const, key: "blocked", value: state.blockedReason }]),
    ];
    const requestBudget = trailing.length === 0 ? maximum : Math.floor(maximum / 2);
    const content: CueLineRunHandoffContent = {
      request: bounded(state.request, requestBudget),
      tasks: {},
    };
    let remaining = maximum - content.request.length;
    trailing.forEach((item, index) => {
      const share = Math.floor(remaining / (trailing.length - index));
      if (share < 1) return;
      const value = bounded(item.value, share);
      remaining -= value.length;
      if (item.kind === "task") content.tasks[item.key] = value;
      else if (item.kind === "final") content.finalDeliveryText = value;
      else content.blockedReason = value;
    });
    packet.content = content;
  }
  return packet;
}

function json(value: string | null): string {
  return JSON.stringify(value);
}

export function renderCueLineRunHandoffMarkdown(packet: CueLineRunHandoffPacket): string {
  const lines = [
    "# CueLine run handoff",
    "",
    `- Run: ${json(packet.run.runId)}`,
    `- Status: ${packet.run.status} / ${packet.run.phase}`,
    `- Executor: ${packet.run.executor}`,
    `- Round: ${packet.run.round}/${packet.run.maxRounds}`,
    `- Event sequence: ${packet.run.eventSequence}`,
    `- Conversation: ${json(packet.conversation.url)}`,
    `- Controller archive: ${packet.conversation.archive.enabled ? packet.conversation.archive.status : "disabled"}`,
    `- Run directory: ${json(packet.paths.runDir)}`,
    `- Event log: ${json(packet.paths.events)}`,
    `- Safe next action: ${packet.run.safeNextAction}`,
    "",
    "## Next step",
    "",
    packet.next.instruction,
    "",
    "```text",
    packet.next.apiExample,
    "```",
    "",
    "Before acting, run:",
    "",
    "```text",
    `cueline run status ${packet.run.runId} --json`,
    "```",
    "",
    "Pro has no local tools. Do not describe a dispatch as local work already performed.",
    "",
    "## Pending controller turns",
    "",
  ];
  if (packet.pendingControllerTurns.length === 0) lines.push("None.");
  for (const turn of packet.pendingControllerTurns) {
    lines.push(
      `- request=${json(turn.requestId)} round=${turn.round} submission=${turn.submissionState} manual=${turn.manualSendConfirmed ? "yes" : "no"} url=${json(turn.conversationUrl)}`,
    );
  }
  lines.push("", "## Jobs", "");
  if (packet.jobs.length === 0) lines.push("None.");
  for (const job of packet.jobs) {
    lines.push(
      `- id=${json(job.jobId)} key=${json(job.jobKey)} mode=${job.mode} status=${job.status} required=${job.required ? "yes" : "no"} workdir=${json(job.workdir ?? null)} task_hash=${job.taskHash}`,
    );
  }
  if (packet.content !== undefined) {
    lines.push("", "## Bounded content", "", `- Request: ${json(packet.content.request)}`);
    for (const [jobId, task] of Object.entries(packet.content.tasks)) {
      lines.push(`- Task ${json(jobId)}: ${json(task)}`);
    }
  }
  return lines.join("\n");
}

export async function createCueLineRunHandoff(
  runId: string,
  options: CueLineRunHandoffOptions = {},
): Promise<CueLineRunHandoffPacket> {
  const environment = options.environment ?? process.env;
  const home = options.home ?? defaultCueLineHome(environment);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const store = await loadPersistedRunStore(home, runId);
    const status = await loadCueLineRunStatus(runId, {
      home,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    if (store.lastSequence === status.lastEventSequence) {
      return buildCueLineRunHandoff(store.state, status, home, options);
    }
  }
  throw new CueLineError(
    "RUN_HANDOFF_SNAPSHOT_CHANGED",
    `Run '${runId}' changed while its handoff packet was being read; retry the read-only command.`,
  );
}
