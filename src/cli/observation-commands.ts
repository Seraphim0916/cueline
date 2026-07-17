import {
  auditCueLineRunSecrets,
  compareCueLineRuns,
  createCueLineRunHandoff,
  diagnoseCueLineRun,
  listCueLineRuns,
  loadCueLineRunGraph,
  loadCueLineRunTimeline,
  loadCueLineRunStatusAt,
  verifyCueLineRun,
  waitForCueLineRunChange,
} from "../api.js";
import { CueLineError } from "../core/errors.js";
import { renderCueLineRunHandoffMarkdown } from "../observation/run-handoff.js";
import { CUELINE_VERSION } from "../version.js";
import type { CliIo } from "./io.js";

async function runsCommand(
  json: boolean,
  environment: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  const runs = await listCueLineRuns({ environment });
  if (json) {
    io.stdout(JSON.stringify(runs, null, 2));
  } else if (runs.length === 0) {
    io.stdout("No runs.");
  } else {
    for (const run of runs) {
      if (!run.readable) {
        io.stdout(`${run.runId}\tunreadable\t${run.errorCode}`);
        continue;
      }
      io.stdout(
        `${run.runId}\t${run.status}\t${run.executor}\t${run.phase}\t${run.safeNextAction}\tround=${run.round}\tpending=${run.pendingTurns}\tactive_jobs=${run.activeJobs}\truntime=${run.runtimeOwnership}\tsequence=${run.lastEventSequence}\tupdated=${run.lastEventAt}`,
      );
    }
  }
  return runs.some((run) => !run.readable) ? 1 : 0;
}

async function runAuditSecretsCommand(
  runId: string,
  json: boolean,
  environment: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  const report = await auditCueLineRunSecrets(runId, { environment });
  if (json) {
    io.stdout(JSON.stringify({ version: CUELINE_VERSION, ...report }, null, 2));
  } else {
    io.stdout(`run\t${report.runId}`);
    io.stdout(`version\t${CUELINE_VERSION}`);
    io.stdout(`protocol\t${report.protocol}`);
    io.stdout(
      `scanned\tevents=${report.scannedEvents}\tfields=${report.scannedFields}`,
    );
    for (const finding of report.findings) {
      io.stdout(
        `finding\t${finding.kind}\tsequence=${finding.sequence}\tevent=${finding.eventType}\tpath=${finding.path}\tlength=${finding.matchLength}\tpreview=${finding.maskedPreview}`,
      );
    }
    io.stdout(`clean\t${report.clean ? "yes" : "no"}`);
  }
  return report.clean ? 0 : 1;
}

async function runVerifyCommand(
  runId: string,
  json: boolean,
  environment: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  const report = await verifyCueLineRun(runId, { environment });
  if (json) {
    io.stdout(JSON.stringify(report, null, 2));
  } else {
    io.stdout(`run\t${report.runId}`);
    io.stdout(`outcome\t${report.outcome}`);
    io.stdout(`marker\t${report.marker}`);
    io.stdout(
      report.eventLog.readable
        ? `events\treadable\ttotal=${report.eventLog.totalEvents}\tauthoritative=${report.eventLog.authoritativeEvents}\tlast_sequence=${report.eventLog.lastSequence}`
        : "events\tunreadable",
    );
    io.stdout(`snapshot\t${report.snapshot}`);
    io.stdout(`runtime\t${report.runtimeOwnership}`);
    for (const item of report.findings) {
      io.stdout(
        `finding\t${item.severity}\t${item.code}\t${item.surface}\t${item.message}`,
      );
    }
  }
  return report.outcome === "verified" ? 0 : 1;
}

async function runDoctorCommand(
  runId: string,
  json: boolean,
  environment: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  const diagnosis = await diagnoseCueLineRun(runId, { environment });
  if (json) {
    io.stdout(JSON.stringify({ version: CUELINE_VERSION, ...diagnosis }, null, 2));
  } else {
    io.stdout(`run\t${diagnosis.runId}`);
    io.stdout(`version\t${CUELINE_VERSION}`);
    io.stdout(`outcome\t${diagnosis.outcome}`);
    io.stdout(`phase\t${diagnosis.phase}`);
    io.stdout(`sequence\t${diagnosis.eventSequence}`);
    io.stdout(`summary\t${diagnosis.summary}`);
    io.stdout(`next\t${diagnosis.nextAction}`);
    for (const finding of diagnosis.findings) {
      io.stdout(
        `finding\t${finding.severity}\t${finding.code}\t${finding.message}\taction=${finding.action}\tevidence=${JSON.stringify(finding.evidence)}`,
      );
    }
  }
  return diagnosis.outcome === "blocked" ? 1 : 0;
}

async function runWatchCommand(
  runId: string,
  afterSequence: number,
  timeoutMs: number | undefined,
  json: boolean,
  environment: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  const observation = await waitForCueLineRunChange(runId, {
    environment,
    afterSequence,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  if (json) {
    io.stdout(JSON.stringify({ version: CUELINE_VERSION, ...observation }, null, 2));
  } else {
    io.stdout(`run\t${observation.status.runId}`);
    io.stdout(`version\t${CUELINE_VERSION}`);
    io.stdout(`outcome\t${observation.outcome}`);
    io.stdout(`sequence\t${observation.previousSequence}->${observation.currentSequence}`);
    io.stdout(`elapsed_ms\t${observation.elapsedMs}`);
    io.stdout(`phase\t${observation.status.phase}`);
    io.stdout(`next\t${observation.status.safeNextAction}`);
  }
  return 0;
}

async function runHandoffCommand(
  runId: string,
  includeContent: boolean,
  maxContentChars: number | undefined,
  jsonOutput: boolean,
  environment: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  const packet = await createCueLineRunHandoff(runId, {
    environment,
    ...(includeContent ? { includeContent: true } : {}),
    ...(maxContentChars === undefined ? {} : { maxContentChars }),
  });
  io.stdout(jsonOutput ? JSON.stringify(packet, null, 2) : renderCueLineRunHandoffMarkdown(packet));
  return 0;
}

async function runTimelineCommand(
  runId: string,
  afterSequence: number,
  limit: number,
  json: boolean,
  environment: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  const timeline = await loadCueLineRunTimeline(runId, {
    environment,
    afterSequence,
    limit,
  });
  if (json) {
    io.stdout(JSON.stringify({ version: CUELINE_VERSION, ...timeline }, null, 2));
  } else {
    io.stdout(`run\t${timeline.runId}`);
    io.stdout(`version\t${CUELINE_VERSION}`);
    io.stdout(
      `events\treturned=${timeline.returnedEvents}\ttotal=${timeline.totalEvents}\tlatest=${timeline.latestSequence}\thas_more=${timeline.hasMore ? "yes" : "no"}\tnext_after=${timeline.nextAfterSequence}`,
    );
    for (const entry of timeline.entries) {
      io.stdout(
        `event\t${entry.sequence}\t${entry.timestamp ?? "invalid_timestamp"}\t${entry.category}\t${entry.type}\t${entry.summary}\tattributes=${JSON.stringify(entry.attributes)}\tpayload_sha256=${entry.payloadHash}\towner=${entry.ownerFingerprint ?? "-"}`,
      );
    }
  }
  return 0;
}

async function runGraphCommand(
  runId: string,
  afterSequence: number,
  limit: number,
  json: boolean,
  environment: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  const graph = await loadCueLineRunGraph(runId, {
    environment,
    afterSequence,
    limit,
  });
  io.stdout(json ? JSON.stringify({ version: CUELINE_VERSION, ...graph }, null, 2) : graph.mermaid);
  return 0;
}

async function runStatusAtCommand(
  runId: string,
  sequence: number,
  json: boolean,
  environment: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  const historical = await loadCueLineRunStatusAt(runId, { environment, sequence });
  if (json) {
    io.stdout(JSON.stringify({ version: CUELINE_VERSION, ...historical }, null, 2));
  } else {
    io.stdout(`run\t${historical.runId}`);
    io.stdout(`version\t${CUELINE_VERSION}`);
    io.stdout(
      `sequence\t${historical.requestedSequence}/${historical.latestSequence}\tauthoritative_applied=${historical.authoritativeEventsApplied}`,
    );
    io.stdout(`event\t${historical.asOf.type}\t${historical.asOf.timestamp}`);
    io.stdout(
      `state\t${historical.state.status}\texecutor=${historical.state.executor}\tround=${historical.state.round}/${historical.state.maxRounds}`,
    );
    io.stdout(
      `controller\tpending=${historical.state.pendingControllerTurns}\tabandoned=${historical.state.abandonedControllerTurns}\taccepted=${historical.state.acceptedCommands}`,
    );
    io.stdout(
      `jobs\ttotal=${historical.state.jobs.total}\tcounts=${JSON.stringify(historical.state.jobs.counts)}`,
    );
  }
  return 0;
}

async function runDiffCommand(
  leftRunId: string,
  rightRunId: string,
  json: boolean,
  environment: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  const comparison = await compareCueLineRuns(leftRunId, rightRunId, { environment });
  if (json) {
    io.stdout(JSON.stringify({ version: CUELINE_VERSION, ...comparison }, null, 2));
  } else {
    io.stdout(`left\t${comparison.left.runId}`);
    io.stdout(`right\t${comparison.right.runId}`);
    io.stdout(`equivalent\t${comparison.equivalent ? "yes" : "no"}`);
    for (const change of comparison.changes) {
      io.stdout(
        `change\t${change.field}\t${JSON.stringify(change.left)}\t${JSON.stringify(change.right)}`,
      );
    }
  }
  return 0;
}

export async function handleObservationCommand(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number | undefined> {
  if (
    args[0] === "runs" &&
    (args.length === 1 || (args.length === 2 && args[1] === "--json"))
  ) {
    return runsCommand(args[1] === "--json", environment, io);
  }
  if (
    args[0] === "run" &&
    args[1] === "verify" &&
    typeof args[2] === "string" &&
    (args.length === 3 || (args.length === 4 && args[3] === "--json"))
  ) {
    return runVerifyCommand(args[2], args[3] === "--json", environment, io);
  }
  if (
    args[0] === "run" &&
    args[1] === "audit-secrets" &&
    typeof args[2] === "string" &&
    (args.length === 3 || (args.length === 4 && args[3] === "--json"))
  ) {
    return runAuditSecretsCommand(args[2], args[3] === "--json", environment, io);
  }
  if (
    args[0] === "run" &&
    args[1] === "doctor" &&
    typeof args[2] === "string" &&
    (args.length === 3 || (args.length === 4 && args[3] === "--json"))
  ) {
    return runDoctorCommand(args[2], args[3] === "--json", environment, io);
  }
  if (args[0] === "run" && args[1] === "status-at" && typeof args[2] === "string") {
    let sequence: number | undefined;
    let json = false;
    let valid = true;
    for (let index = 3; index < args.length; index += 1) {
      const argument = args[index];
      if (
        argument === "--sequence" &&
        sequence === undefined &&
        typeof args[index + 1] === "string"
      ) {
        sequence = Number(args[index + 1]);
        index += 1;
      } else if (argument === "--json" && !json) {
        json = true;
      } else {
        valid = false;
      }
    }
    if (!valid || sequence === undefined || !Number.isSafeInteger(sequence) || sequence < 1) {
      throw new CueLineError(
        "CLI_ARGUMENTS_INVALID",
        "usage: cueline run status-at <run-id> --sequence <positive-integer> [--json]",
      );
    }
    return runStatusAtCommand(args[2], sequence, json, environment, io);
  }
  if (
    args[0] === "run" &&
    args[1] === "diff" &&
    typeof args[2] === "string" &&
    typeof args[3] === "string" &&
    (args.length === 4 || (args.length === 5 && args[4] === "--json"))
  ) {
    return runDiffCommand(args[2], args[3], args[4] === "--json", environment, io);
  }
  if (args[0] === "run" && args[1] === "watch" && typeof args[2] === "string") {
    let afterSequence: number | undefined;
    let timeoutMs: number | undefined;
    let json = false;
    let valid = true;
    for (let index = 3; index < args.length; index += 1) {
      const argument = args[index];
      if (
        argument === "--after" &&
        afterSequence === undefined &&
        typeof args[index + 1] === "string"
      ) {
        afterSequence = Number(args[index + 1]);
        index += 1;
      } else if (
        argument === "--timeout-ms" &&
        timeoutMs === undefined &&
        typeof args[index + 1] === "string"
      ) {
        timeoutMs = Number(args[index + 1]);
        index += 1;
      } else if (argument === "--json" && !json) {
        json = true;
      } else {
        valid = false;
      }
    }
    if (
      !valid ||
      afterSequence === undefined ||
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < 0 ||
      (timeoutMs !== undefined &&
        (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000))
    ) {
      throw new CueLineError(
        "CLI_ARGUMENTS_INVALID",
        "usage: cueline run watch <run-id> --after <sequence> [--timeout-ms <0..30000>] [--json]",
      );
    }
    return runWatchCommand(args[2], afterSequence, timeoutMs, json, environment, io);
  }
  if (args[0] === "run" && args[1] === "handoff" && typeof args[2] === "string") {
    let includeContent = false;
    let maxContentChars: number | undefined;
    let json = false;
    let valid = true;
    for (let index = 3; index < args.length; index += 1) {
      const argument = args[index];
      if (argument === "--include-content" && !includeContent) {
        includeContent = true;
      } else if (
        argument === "--max-content-chars" &&
        maxContentChars === undefined &&
        typeof args[index + 1] === "string"
      ) {
        maxContentChars = Number(args[index + 1]);
        index += 1;
      } else if (argument === "--json" && !json) {
        json = true;
      } else {
        valid = false;
      }
    }
    if (
      !valid ||
      (maxContentChars !== undefined && !includeContent) ||
      (maxContentChars !== undefined &&
        (!Number.isSafeInteger(maxContentChars) ||
          maxContentChars < 16 ||
          maxContentChars > 10_000))
    ) {
      throw new CueLineError(
        "CLI_ARGUMENTS_INVALID",
        "usage: cueline run handoff <run-id> [--include-content] [--max-content-chars <16..10000>] [--json]",
      );
    }
    return runHandoffCommand(
      args[2],
      includeContent,
      maxContentChars,
      json,
      environment,
      io,
    );
  }
  if (args[0] === "run" && args[1] === "timeline" && typeof args[2] === "string") {
    let afterSequence = 0;
    let limit = 100;
    let afterProvided = false;
    let limitProvided = false;
    let json = false;
    let valid = true;
    for (let index = 3; index < args.length; index += 1) {
      const argument = args[index];
      if (
        argument === "--after" &&
        !afterProvided &&
        typeof args[index + 1] === "string"
      ) {
        afterSequence = Number(args[index + 1]);
        afterProvided = true;
        index += 1;
      } else if (
        argument === "--limit" &&
        !limitProvided &&
        typeof args[index + 1] === "string"
      ) {
        limit = Number(args[index + 1]);
        limitProvided = true;
        index += 1;
      } else if (argument === "--json" && !json) {
        json = true;
      } else {
        valid = false;
      }
    }
    if (
      !valid ||
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1_000
    ) {
      throw new CueLineError(
        "CLI_ARGUMENTS_INVALID",
        "usage: cueline run timeline <run-id> [--after <sequence>] [--limit <1..1000>] [--json]",
      );
    }
    return runTimelineCommand(args[2], afterSequence, limit, json, environment, io);
  }
  if (args[0] === "run" && args[1] === "graph" && typeof args[2] === "string") {
    let afterSequence = 0;
    let limit = 100;
    let afterProvided = false;
    let limitProvided = false;
    let json = false;
    let valid = true;
    for (let index = 3; index < args.length; index += 1) {
      const argument = args[index];
      if (
        argument === "--after" &&
        !afterProvided &&
        typeof args[index + 1] === "string"
      ) {
        afterSequence = Number(args[index + 1]);
        afterProvided = true;
        index += 1;
      } else if (
        argument === "--limit" &&
        !limitProvided &&
        typeof args[index + 1] === "string"
      ) {
        limit = Number(args[index + 1]);
        limitProvided = true;
        index += 1;
      } else if (argument === "--json" && !json) {
        json = true;
      } else {
        valid = false;
      }
    }
    if (
      !valid ||
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200
    ) {
      throw new CueLineError(
        "CLI_ARGUMENTS_INVALID",
        "usage: cueline run graph <run-id> [--after <sequence>] [--limit <1..200>] [--json]",
      );
    }
    return runGraphCommand(args[2], afterSequence, limit, json, environment, io);
  }
  return undefined;
}
