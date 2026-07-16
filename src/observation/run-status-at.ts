import type { CueLineRuntimeOptions } from "../api-contracts.js";
import { CueLineError } from "../core/errors.js";
import { loadPersistedRunStore } from "../core/persisted-run.js";
import { initialRunState, reduceRunState } from "../core/state-machine.js";
import { readEvents } from "../state/event-log.js";
import { defaultCueLineHome, runPaths } from "../state/paths.js";
import { readAuthoritativeRunEvents } from "../state/store.js";

export interface CueLineRunStatusAtOptions
  extends Pick<CueLineRuntimeOptions, "environment" | "home"> {
  sequence: number;
}

export interface CueLineRunStatusAt {
  schema: "cueline-status-at/0.1";
  runId: string;
  requestedSequence: number;
  latestSequence: number;
  latestAuthoritativeSequence: number;
  totalEvents: number;
  authoritativeEvents: number;
  authoritativeEventsApplied: number;
  ignoredNonAuthoritativeEventsThroughSequence: number;
  asOf: { type: string; timestamp: string };
  state: {
    status: string;
    executor: string;
    allowProcessExecution: boolean;
    round: number;
    maxRounds: number;
    conversationBound: boolean;
    pendingControllerTurns: number;
    abandonedControllerTurns: number;
    acceptedCommands: number;
    pendingCommandExecution: boolean;
    jobs: { total: number; counts: Record<string, number> };
    archiveStatus: string;
    finalDeliveryAvailable: boolean;
    blockedReasonAvailable: boolean;
    cancelledReasonAvailable: boolean;
    lastFailureCode: string | null;
  };
}

export async function loadCueLineRunStatusAt(
  runId: string,
  options: CueLineRunStatusAtOptions,
): Promise<CueLineRunStatusAt> {
  if (!Number.isSafeInteger(options.sequence) || options.sequence < 1) {
    throw new CueLineError(
      "RUN_STATUS_AT_SEQUENCE_INVALID",
      "Historical status requires a positive safe event sequence.",
    );
  }
  const environment = options.environment ?? process.env;
  const home = options.home ?? defaultCueLineHome(environment);
  await loadPersistedRunStore(home, runId);
  const [events, authoritativeEvents] = await Promise.all([
    readEvents(runPaths(home, runId).events),
    readAuthoritativeRunEvents(home, runId),
  ]);
  const latestSequence = events.at(-1)?.sequence ?? 0;
  if (options.sequence > latestSequence) {
    throw new CueLineError(
      "RUN_STATUS_AT_SEQUENCE_AHEAD",
      `Run '${runId}' is at event ${latestSequence}, behind requested sequence ${options.sequence}.`,
    );
  }
  const eventAt = events.find((event) => event.sequence === options.sequence);
  if (eventAt === undefined) {
    throw new CueLineError(
      "RUN_STATUS_AT_SEQUENCE_MISSING",
      `Run '${runId}' has no durable event at sequence ${options.sequence}.`,
    );
  }
  const applied = authoritativeEvents.filter((event) => event.sequence <= options.sequence);
  let state = initialRunState(runId, "");
  for (const event of applied) state = reduceRunState(state, event);
  const counts: Record<string, number> = {};
  for (const job of Object.values(state.jobs)) {
    counts[job.status] = (counts[job.status] ?? 0) + 1;
  }
  return {
    schema: "cueline-status-at/0.1",
    runId,
    requestedSequence: options.sequence,
    latestSequence,
    latestAuthoritativeSequence: authoritativeEvents.at(-1)?.sequence ?? 0,
    totalEvents: events.length,
    authoritativeEvents: authoritativeEvents.length,
    authoritativeEventsApplied: applied.length,
    ignoredNonAuthoritativeEventsThroughSequence:
      events.filter((event) => event.sequence <= options.sequence).length - applied.length,
    asOf: { type: eventAt.type, timestamp: eventAt.timestamp },
    state: {
      status: state.status,
      executor: state.executor,
      allowProcessExecution: state.allowProcessExecution,
      round: state.round,
      maxRounds: state.maxRounds,
      conversationBound: state.conversationUrl !== null,
      pendingControllerTurns: state.pendingControllerTurns.length,
      abandonedControllerTurns: state.abandonedControllerTurns.length,
      acceptedCommands: state.commandHashes.length,
      pendingCommandExecution: state.pendingCommandExecution !== null,
      jobs: { total: Object.keys(state.jobs).length, counts },
      archiveStatus: state.controllerConversationArchive.status,
      finalDeliveryAvailable: state.finalDeliveryText !== null,
      blockedReasonAvailable: state.blockedReason !== null,
      cancelledReasonAvailable: state.cancelledReason !== null,
      lastFailureCode: state.lastFailure?.code ?? null,
    },
  };
}
