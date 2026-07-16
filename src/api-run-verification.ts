import { readFile } from "node:fs/promises";

import type {
  CueLineRunVerificationFinding,
  CueLineRunVerificationReport,
  CueLineRuntimeOptions,
} from "./api-contracts.js";
import { loadCueLineRunStatus } from "./api-runtime-lifecycle.js";
import { canonicalJson } from "./core/ids.js";
import { runtimeEnvironment } from "./core/runtime.js";
import { initialRunState, reduceRunState } from "./core/state-machine.js";
import { JobStatusStore } from "./jobs/status.js";
import { readEvents, type RunEvent } from "./state/event-log.js";
import { defaultCueLineHome, runPaths } from "./state/paths.js";
import { readRuntimeLease } from "./state/runtime-lease.js";
import { readAuthoritativeRunEvents, STATE_PROTOCOL } from "./state/store.js";

interface SnapshotRecord {
  protocol: unknown;
  run_id: unknown;
  last_sequence: unknown;
  state: unknown;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function finding(
  code: string,
  severity: CueLineRunVerificationFinding["severity"],
  surface: CueLineRunVerificationFinding["surface"],
  message: string,
): CueLineRunVerificationFinding {
  return { code, severity, surface, message };
}

function outcomeFor(
  findings: readonly CueLineRunVerificationFinding[],
): CueLineRunVerificationReport["outcome"] {
  if (findings.some((item) => item.severity === "error")) return "unreadable";
  return findings.length === 0 ? "verified" : "degraded";
}

async function verifyMarker(
  markerPath: string,
  runId: string,
  findings: CueLineRunVerificationFinding[],
): Promise<CueLineRunVerificationReport["marker"]> {
  let content: string;
  try {
    content = await readFile(markerPath, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      findings.push(
        finding(
          "RUN_MARKER_MISSING",
          "warning",
          "marker",
          "The exclusive run creation marker is missing.",
        ),
      );
      return "missing";
    }
    findings.push(
      finding(
        "RUN_MARKER_UNREADABLE",
        "warning",
        "marker",
        "The exclusive run creation marker cannot be read.",
      ),
    );
    return "invalid";
  }
  if (content !== `${runId}\n`) {
    findings.push(
      finding(
        "RUN_MARKER_MISMATCH",
        "warning",
        "marker",
        "The creation marker does not identify this run exactly.",
      ),
    );
    return "invalid";
  }
  return "valid";
}

function replayAt(runId: string, events: readonly RunEvent[], sequence: number): unknown {
  let state = initialRunState(runId, "");
  for (const event of events) {
    if (event.sequence > sequence) break;
    state = reduceRunState(state, event);
  }
  return state;
}

async function verifySnapshot(
  snapshotPath: string,
  runId: string,
  lastSequence: number,
  authoritativeEvents: readonly RunEvent[],
  findings: CueLineRunVerificationFinding[],
): Promise<CueLineRunVerificationReport["snapshot"]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(snapshotPath, "utf8"));
  } catch (error) {
    if (isNotFound(error)) return "missing";
    findings.push(
      finding(
        "SNAPSHOT_INVALID_JSON",
        "warning",
        "snapshot",
        "The optional materialized snapshot is unreadable JSON; event replay remains authoritative.",
      ),
    );
    return "invalid";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    findings.push(
      finding(
        "SNAPSHOT_SCHEMA_INVALID",
        "warning",
        "snapshot",
        "The optional materialized snapshot is not an object.",
      ),
    );
    return "invalid";
  }
  const record = parsed as SnapshotRecord;
  if (record.protocol !== STATE_PROTOCOL) {
    findings.push(
      finding(
        "SNAPSHOT_PROTOCOL_MISMATCH",
        "warning",
        "snapshot",
        "The optional materialized snapshot uses an unsupported state protocol.",
      ),
    );
    return "invalid";
  }
  if (record.run_id !== runId) {
    findings.push(
      finding(
        "SNAPSHOT_RUN_ID_MISMATCH",
        "warning",
        "snapshot",
        "The optional materialized snapshot belongs to another run.",
      ),
    );
    return "invalid";
  }
  if (
    !Number.isSafeInteger(record.last_sequence) ||
    (record.last_sequence as number) < 0 ||
    (record.last_sequence as number) > lastSequence
  ) {
    findings.push(
      finding(
        "SNAPSHOT_SEQUENCE_INVALID",
        "warning",
        "snapshot",
        "The optional materialized snapshot sequence is outside the authoritative event range.",
      ),
    );
    return "invalid";
  }
  if (!Object.prototype.hasOwnProperty.call(record, "state")) {
    findings.push(
      finding(
        "SNAPSHOT_SCHEMA_INVALID",
        "warning",
        "snapshot",
        "The optional materialized snapshot has no state value.",
      ),
    );
    return "invalid";
  }
  const snapshotSequence = record.last_sequence as number;
  const expected = replayAt(runId, authoritativeEvents, snapshotSequence);
  if (canonicalJson(record.state) !== canonicalJson(expected)) {
    findings.push(
      finding(
        "SNAPSHOT_STATE_MISMATCH",
        "warning",
        "snapshot",
        "The optional materialized snapshot does not match authoritative replay at its sequence.",
      ),
    );
    return "invalid";
  }
  return snapshotSequence < lastSequence ? "stale" : "valid";
}

/** Read-only integrity verification. No raw durable content is returned. */
export async function verifyCueLineRun(
  runId: string,
  options: Pick<CueLineRuntimeOptions, "home" | "environment" | "now"> = {},
): Promise<CueLineRunVerificationReport> {
  const environment = options.environment ?? runtimeEnvironment();
  const home = options.home ?? defaultCueLineHome(environment);
  const paths = runPaths(home, runId);
  const findings: CueLineRunVerificationFinding[] = [];
  const marker = await verifyMarker(paths.creationMarker, runId, findings);
  const runtime = await readRuntimeLease(home, runId, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  let events: RunEvent[];
  let authoritativeEvents: RunEvent[];
  try {
    [events, authoritativeEvents] = await Promise.all([
      readEvents(paths.events),
      readAuthoritativeRunEvents(home, runId),
    ]);
  } catch {
    findings.push(
      finding(
        "EVENT_LOG_UNREADABLE",
        "error",
        "events",
        "The append-only event log or its authority fence cannot be replayed.",
      ),
    );
    return {
      runId,
      outcome: outcomeFor(findings),
      marker,
      eventLog: {
        readable: false,
        totalEvents: 0,
        authoritativeEvents: 0,
        lastSequence: null,
      },
      snapshot: "missing",
      runtimeOwnership: runtime.ownership,
      findings,
    };
  }

  const lastSequence = events.at(-1)?.sequence ?? 0;
  if (events.some((event) => !Number.isFinite(Date.parse(event.timestamp)))) {
    findings.push(
      finding(
        "EVENT_TIMESTAMP_INVALID",
        "warning",
        "events",
        "At least one event timestamp cannot be interpreted.",
      ),
    );
  }
  const snapshot = await verifySnapshot(
    paths.snapshot,
    runId,
    lastSequence,
    authoritativeEvents,
    findings,
  );
  if (runtime.ownership === "invalid") {
    findings.push(
      finding(
        "RUNTIME_LEASE_INVALID",
        "warning",
        "runtime",
        "Runtime ownership evidence is unreadable.",
      ),
    );
  }

  try {
    const status = await loadCueLineRunStatus(runId, options);
    const statusStore = new JobStatusStore(home);
    const persistedStatuses = await Promise.all(
      status.jobs.items.map((job) => statusStore.read(job.jobId)),
    );
    const identityMismatch = status.jobs.items.some((job, index) => {
      const persisted = persistedStatuses[index];
      return (
        persisted !== undefined &&
        ((persisted.runId !== undefined && persisted.runId !== runId) ||
          (persisted.jobKey !== undefined && persisted.jobKey !== job.jobKey))
      );
    });
    if (identityMismatch) {
      findings.push(
        finding(
          "JOB_STATUS_IDENTITY_MISMATCH",
          "warning",
          "jobs",
          "At least one job status file claims a different run or job key.",
        ),
      );
    } else if (
      status.jobs.items.some(
        (job, index) =>
          persistedStatuses[index] !== undefined &&
          persistedStatuses[index]?.status !== job.persistedStatus,
      )
    ) {
      findings.push(
        finding(
          "JOB_STATUS_CONFLICT",
          "warning",
          "jobs",
          "At least one job status file conflicts with authoritative run events.",
        ),
      );
    }
  } catch {
    findings.push(
      finding(
        "RUN_STATUS_UNREADABLE",
        "error",
        "events",
        "The run cannot be reduced into a complete status summary.",
      ),
    );
  }

  return {
    runId,
    outcome: outcomeFor(findings),
    marker,
    eventLog: {
      readable: true,
      totalEvents: events.length,
      authoritativeEvents: authoritativeEvents.length,
      lastSequence,
    },
    snapshot,
    runtimeOwnership: runtime.ownership,
    findings,
  };
}
