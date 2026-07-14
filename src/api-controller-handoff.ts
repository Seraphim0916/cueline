import type {
  CueLineCallerJobResultInput,
  CueLineCallerJobSubmissionResult,
  CueLineRuntimeOptions,
  ManualControllerSubmissionConfirmation,
} from "./api-contracts.js";
import { CueLineError } from "./core/errors.js";
import { loadPersistedRunStore } from "./core/persisted-run.js";
import { runtimeEnvironment } from "./core/runtime.js";
import { JobStatusStore, type JobStatus } from "./jobs/status.js";
import { defaultCueLineHome } from "./state/paths.js";
import {
  readRuntimeLease,
  retireDeadRuntimeLease,
  RuntimeLease,
} from "./state/runtime-lease.js";
import { readAuthoritativeRunEvents } from "./state/store.js";

function normalizedConversationUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return value;
  }
}

export async function confirmManualControllerSubmission(
  runId: string,
  options: Pick<CueLineRuntimeOptions, "home" | "environment" | "now"> & {
    requestId: string;
    conversationUrl?: string;
  },
): Promise<ManualControllerSubmissionConfirmation> {
  const environment = options.environment ?? runtimeEnvironment();
  const home = options.home ?? defaultCueLineHome(environment);
  await loadPersistedRunStore(home, runId);
  const runtime = await readRuntimeLease(home, runId, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const retiredOwner =
    (runtime.ownership === "active" || runtime.ownership === "stale") &&
    runtime.ownerId !== undefined &&
    (await retireDeadRuntimeLease(home, runId, runtime.ownerId))
      ? { ownerId: runtime.ownerId, ownership: runtime.ownership }
      : undefined;
  const lease = await RuntimeLease.claim({
    home,
    runId,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  try {
    const store = await loadPersistedRunStore(home, runId);
    store.bindRuntimeOwner(lease.ownerId);
    if (retiredOwner !== undefined) {
      await store.append("runtime_dead_owner_retired", {
        owner_id: retiredOwner.ownerId,
        previous_ownership: retiredOwner.ownership,
      });
    }
    const state = store.state;
    const turn =
      (state.pendingControllerTurns ?? []).find(
        (candidate) => candidate.requestId === options.requestId,
      ) ??
      (state.abandonedControllerTurns ?? []).find(
        (candidate) => candidate.requestId === options.requestId,
      );
    if (!turn) {
      throw new CueLineError(
        "CONTROLLER_RECONCILIATION_REQUEST_NOT_FOUND",
        `Controller request '${options.requestId}' is neither pending nor recoverably abandoned in run '${runId}'.`,
      );
    }
    const conversationUrl =
      options.conversationUrl ?? turn.conversationUrl ?? state.conversationUrl;
    if (!conversationUrl || !state.conversationUrl) {
      throw new CueLineError(
        "CONTROLLER_RECONCILIATION_URL_REQUIRED",
        "Manual submission confirmation requires the exact persisted ChatGPT conversation URL.",
      );
    }
    if (
      normalizedConversationUrl(conversationUrl) !==
      normalizedConversationUrl(state.conversationUrl)
    ) {
      throw new CueLineError(
        "CONTROLLER_RECONCILIATION_CONVERSATION_MISMATCH",
        "The operator-confirmed conversation URL does not match the persisted CueLine conversation.",
      );
    }
    if (
      turn.conversationUrl !== null &&
      normalizedConversationUrl(conversationUrl) !==
        normalizedConversationUrl(turn.conversationUrl)
    ) {
      throw new CueLineError(
        "CONTROLLER_RECONCILIATION_CONVERSATION_MISMATCH",
        "The operator-confirmed conversation URL does not match the exact conversation bound to this controller turn.",
      );
    }
    const events = await readAuthoritativeRunEvents(home, runId);
    for (const event of events) {
      if (event.type !== "controller_command_accepted") continue;
      const payload =
        typeof event.payload === "object" &&
        event.payload !== null &&
        !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>)
          : {};
      const command =
        typeof payload.command === "object" &&
        payload.command !== null &&
        !Array.isArray(payload.command)
          ? (payload.command as Record<string, unknown>)
          : {};
      const acceptedRequestId = command.request_id;
      const acceptedRound = command.round;
      if (
        acceptedRequestId === options.requestId ||
        (typeof acceptedRound === "number" && acceptedRound >= turn.round)
      ) {
        throw new CueLineError(
          "CONTROLLER_RECONCILIATION_SUPERSEDED",
          "A command for this request or the same/newer controller round was already accepted; refusing duplicate reconciliation.",
        );
      }
    }
    if (turn.manualSendConfirmed) {
      return {
        runId,
        requestId: turn.requestId,
        conversationUrl,
        outcome: "already_confirmed",
      };
    }
    await store.append("controller_turn_manual_submission_confirmed", {
      round: turn.round,
      request_id: turn.requestId,
      conversation_url: conversationUrl,
      operator_confirmation: true,
    });
    await store.snapshot();
    return { runId, requestId: turn.requestId, conversationUrl, outcome: "confirmed" };
  } finally {
    await lease.release();
  }
}

function assertCallerJobResultInput(
  input: unknown,
): asserts input is CueLineCallerJobResultInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new CueLineError("CALLER_JOB_RESULT_INVALID", "Caller job result must be an object.");
  }
  const value = input as Record<string, unknown>;
  const terminalStatuses = new Set([
    "succeeded",
    "failed",
    "timed_out",
    "cancelled",
    "ambiguous",
  ]);
  if (typeof value.status !== "string" || !terminalStatuses.has(value.status)) {
    throw new CueLineError(
      "CALLER_JOB_STATUS_INVALID",
      `Unsupported caller job status '${String(value.status)}'.`,
    );
  }
  for (const field of [
    "stdout",
    "stderr",
    "output",
    "error",
    "startedAt",
    "finishedAt",
  ] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new CueLineError(
        "CALLER_JOB_RESULT_INVALID",
        `Caller job result field '${field}' must be a string when provided.`,
      );
    }
  }
  if (
    value.exitCode !== undefined &&
    value.exitCode !== null &&
    !Number.isSafeInteger(value.exitCode)
  ) {
    throw new CueLineError(
      "CALLER_JOB_RESULT_INVALID",
      "Caller job result exitCode must be a safe integer or null when provided.",
    );
  }
}

export async function submitCueLineCallerJobResult(
  runId: string,
  jobId: string,
  input: CueLineCallerJobResultInput,
  options: Pick<CueLineRuntimeOptions, "home" | "environment" | "now"> = {},
): Promise<CueLineCallerJobSubmissionResult> {
  const environment = options.environment ?? runtimeEnvironment();
  const home = options.home ?? defaultCueLineHome(environment);
  const now = options.now ?? (() => new Date());
  assertCallerJobResultInput(input);
  await loadPersistedRunStore(home, runId);
  const runtime = await readRuntimeLease(home, runId, { now });
  const retiredOwner =
    (runtime.ownership === "active" || runtime.ownership === "stale") &&
    runtime.ownerId !== undefined &&
    (await retireDeadRuntimeLease(home, runId, runtime.ownerId))
      ? { ownerId: runtime.ownerId, ownership: runtime.ownership }
      : undefined;
  const lease = await RuntimeLease.claim({ home, runId, now });
  try {
    const store = await loadPersistedRunStore(home, runId);
    store.bindRuntimeOwner(lease.ownerId);
    if (retiredOwner !== undefined) {
      await store.append("runtime_dead_owner_retired", {
        owner_id: retiredOwner.ownerId,
        previous_ownership: retiredOwner.ownership,
      });
    }
    if (store.state.executor !== "caller") {
      throw new CueLineError(
        "CALLER_EXECUTOR_REQUIRED",
        `Run '${runId}' uses the process executor; caller results are not accepted.`,
      );
    }
    const job = store.state.jobs[jobId];
    if (!job) {
      throw new CueLineError("JOB_NOT_FOUND", `No job '${jobId}' exists in run '${runId}'.`);
    }
    if (job.status !== "pending" && job.status !== "running") {
      return { runId, jobId, outcome: "already_terminal" };
    }
    const statusStore = new JobStatusStore(home);
    let terminal = await statusStore.read(jobId);
    if (terminal?.status === "pending" || terminal?.status === "running") {
      terminal = undefined;
    }
    if (terminal !== undefined) {
      if (terminal.runId !== runId || terminal.jobKey !== job.jobKey) {
        throw new CueLineError(
          "CALLER_JOB_RESULT_CONFLICT",
          `Persisted terminal evidence for '${jobId}' does not belong to this caller job.`,
        );
      }
    } else {
      const stdout = input.stdout ?? "";
      const stderr = input.stderr ?? "";
      const output =
        input.output ??
        (stdout === ""
          ? stderr
          : stderr === ""
            ? stdout
            : `${stdout}${stdout.endsWith("\n") ? "" : "\n"}${stderr}`);
      const startedAt = input.startedAt ?? now().toISOString();
      const finishedAt = input.finishedAt ?? now().toISOString();
      const result = {
        status: input.status,
        exitCode: input.exitCode ?? (input.status === "succeeded" ? 0 : null),
        stdout,
        stderr,
        output,
        emptyOutput: output.length === 0,
        timedOut: input.status === "timed_out",
        cancelled: input.status === "cancelled",
        ambiguousSideEffects: job.spec.mode === "work" && input.status !== "succeeded",
        retryable: false as const,
        startedAt,
        finishedAt,
      };
      terminal = {
        jobId,
        runId,
        jobKey: job.jobKey,
        lane: job.spec.lane,
        mode: job.spec.mode,
        execution: "foreground",
        status: input.status,
        startedAt,
        finishedAt,
        result,
        ...(input.error === undefined ? {} : { error: input.error }),
      } satisfies JobStatus;
      await statusStore.write(terminal);
    }
    const events = await readAuthoritativeRunEvents(home, runId);
    const alreadyRecorded = events.some((event) => {
      if (event.type !== "caller_job_result_submitted") return false;
      const payload =
        typeof event.payload === "object" &&
        event.payload !== null &&
        !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>)
          : {};
      return payload.job_id === jobId;
    });
    if (!alreadyRecorded) {
      await store.append("caller_job_result_submitted", {
        job_id: jobId,
        status: terminal.status,
      });
    }
    const terminalResult = terminal.result;
    const controllerOutput =
      terminal.status === "succeeded" && terminalResult?.stdout.trim() !== ""
        ? terminalResult?.stdout
        : terminalResult?.output;
    await store.append("job_status", {
      job_id: jobId,
      status: terminal.status,
      ...(controllerOutput === undefined ? {} : { output: controllerOutput }),
      ...(terminal.error === undefined ? {} : { error: terminal.error }),
    });
    await store.snapshot();
    return { runId, jobId, outcome: "submitted" };
  } finally {
    await lease.release();
  }
}
