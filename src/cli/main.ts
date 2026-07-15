#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  cancelCueLineJob,
  cancelCueLineRun,
  confirmManualControllerSubmission,
  loadCueLineRunStatus,
  reconcileCueLineRuntime,
  routingConfigPath,
  takeoverCueLineRuntime,
  waitForCueLineRunChange,
} from "../api.js";
import { CueLineError } from "../core/errors.js";
import type { JobStatus } from "../jobs/status.js";
import { executableAvailability } from "../router/availability.js";
import { loadRoutingConfig } from "../router/config-loader.js";
import { resolveRoute } from "../router/resolver.js";
import { defaultCueLineHome } from "../state/paths.js";
import { readRuntimeLease } from "../state/runtime-lease.js";
import { readAuthoritativeRunEvents } from "../state/store.js";
import { CUELINE_VERSION } from "../version.js";
import { installSkill, uninstallSkill } from "./skill-links.js";

interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const processIo: CliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

function usage(): string {
  return "usage: cueline <install|uninstall|doctor|routing|jobs|run status|run watch|run reconcile|run takeover|run reconcile-runtime|run cancel|run stop|job cancel|api path|config path|help|version>";
}

function help(): string {
  return [
    "CueLine — a ChatGPT web conversation directs; this machine executes.",
    "",
    usage(),
    "",
    "commands:",
    "  install        link the bundled skill into Codex",
    "  uninstall      remove only the skill link owned by this package",
    "  doctor         report Node, caller readiness, state home, and process lanes",
    "  routing        list every lane and the candidate that would be selected",
    "  jobs           list persisted local jobs with run, key, lane, mode, and PID",
    "  run status     summarize one persisted run for safe cross-session handoff",
    "  run watch      wait briefly for a newer durable event without owning the run",
    "  run reconcile  confirm one manually sent controller turn; never resends it",
    "  run takeover   explicitly retire one exact stale runtime owner",
    "  run reconcile-runtime  settle dead ownerless workers from persisted evidence",
    "  run cancel     request safe cancellation; ownerless work becomes ambiguous",
    "  run stop       alias for `run cancel`",
    "  job cancel     request cancellation for one job in one run",
    "  api path       print the bundled API module path",
    "  config path    print the routing configuration file in effect",
    "  help           print this text",
    "  version        print the CueLine version",
    "",
    "command syntax:",
    "  cueline install",
    "  cueline uninstall",
    "  cueline doctor",
    "  cueline routing",
    "  cueline jobs [--json]",
    "  cueline run status <run-id> [--json]",
    "  cueline run watch <run-id> --after <sequence> [--timeout-ms <0..30000>] [--json]",
    "  cueline run reconcile <run-id> --request-id <request-id> --manual-send-confirmed [--conversation-url <url>] [--json]",
    "  cueline run takeover <run-id> [--json]",
    "  cueline run reconcile-runtime <run-id> [--json]",
    "  cueline run cancel <run-id> [--json]",
    "  cueline run stop <run-id> [--json]",
    "  cueline job cancel <run-id> <job-id> [--json]",
    "  cueline api path",
    "  cueline config path",
    "  cueline help",
    "  cueline version",
    "",
    "flags:",
    "  -h, --help     same as `cueline help`",
    "  -v, --version  same as `cueline version`",
    "",
    "environment:",
    "  CUELINE_HOME    run and job state directory (default: ~/.cueline)",
    "  CUELINE_CONFIG  routing configuration file (default: the bundled config)",
    "",
    "exit codes:",
    "  0  the command answered and the checked surface is usable",
    "  1  the command ran but the surface is degraded or unreadable",
    "  2  the arguments were not understood",
    "",
    "state effects:",
    "  Read-only: doctor, routing, jobs, run status, run watch, api path, config path, help, version.",
    "  Local setup: install and uninstall change only the package-owned skill link.",
    "  Durable state writes: run reconcile, takeover, reconcile-runtime, cancel/stop,",
    "  and job cancel append evidence or change local run/job state.",
    "",
    "No CLI command drives the browser. A live run is driven through the imported API",
    "inside Codex, where the built-in Browser lives.",
  ].join("\n");
}

function errorMessage(error: unknown): string {
  if (error instanceof CueLineError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

async function routingCommand(environment: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const config = await loadRoutingConfig(routingConfigPath(environment));
  const availability = executableAvailability(environment);
  let available = 0;
  for (const [lane, laneConfig] of Object.entries(config.lanes)) {
    if (!laneConfig.enabled) {
      io.stdout(`${lane}\t-\tdisabled`);
      continue;
    }
    try {
      const route = resolveRoute(lane, config, availability);
      available += 1;
      io.stdout(`${lane}\t${route.candidate.id}\tavailable`);
    } catch (error) {
      io.stdout(`${lane}\t-\tunavailable (${errorMessage(error)})`);
    }
  }
  return available > 0 ? 0 : 1;
}

type ObservedJobStatus = JobStatus["status"] | "orphaned" | "unverified" | "conflict";
type ListedJobStatus = JobStatus & {
  observedStatus: ObservedJobStatus;
  task?: string;
  persistedStatus?: JobStatus["status"];
};

type RunJobMetadata = JobStatus & { task?: string };

async function readRunJobMetadata(home: string): Promise<Map<string, RunJobMetadata>> {
  const metadata = new Map<string, RunJobMetadata>();
  let entries;
  try {
    entries = await readdir(path.join(home, "runs"), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return metadata;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const events = await readAuthoritativeRunEvents(home, entry.name);
    for (const event of events) {
      if (
        typeof event.payload !== "object" ||
        event.payload === null ||
        Array.isArray(event.payload)
      ) continue;
      const payload = event.payload as Record<string, unknown>;
      if (event.type === "job_registered") {
        const job = payload.job;
        if (typeof job !== "object" || job === null || Array.isArray(job)) continue;
        const record = job as Record<string, unknown>;
        const spec =
          typeof record.spec === "object" && record.spec !== null && !Array.isArray(record.spec)
            ? (record.spec as Record<string, unknown>)
            : {};
        if (
          typeof record.jobId !== "string" ||
          typeof record.jobKey !== "string" ||
          typeof spec.lane !== "string" ||
          typeof spec.task !== "string" ||
          (spec.mode !== "advise" && spec.mode !== "work")
        ) continue;
        metadata.set(record.jobId, {
          jobId: record.jobId,
          runId: entry.name,
          jobKey: record.jobKey,
          lane: spec.lane,
          mode: spec.mode,
          task: spec.task,
          execution: "foreground",
          status: "pending",
          startedAt: event.timestamp,
        });
      } else if (event.type === "job_status" && typeof payload.job_id === "string") {
        const existing = metadata.get(payload.job_id);
        const status = payload.status;
        if (
          existing === undefined ||
          (status !== "pending" &&
            status !== "running" &&
            status !== "succeeded" &&
            status !== "failed" &&
            status !== "timed_out" &&
            status !== "cancelled" &&
            status !== "ambiguous")
        ) continue;
        metadata.set(payload.job_id, {
          ...existing,
          status,
          ...(typeof payload.runner_id === "string"
            ? { runnerId: payload.runner_id }
            : {}),
          ...(typeof payload.pid === "number" ? { pid: payload.pid } : {}),
          ...(typeof payload.model === "string" ? { model: payload.model } : {}),
          ...(typeof payload.provider === "string" ? { provider: payload.provider } : {}),
          ...(typeof payload.phase === "string" ? { phase: payload.phase } : {}),
          ...(typeof payload.last_progress_at === "string"
            ? { lastProgressAt: payload.last_progress_at }
            : {}),
          ...(status === "pending" || status === "running"
            ? {}
            : { finishedAt: event.timestamp }),
        });
      }
    }
  }
  return metadata;
}

async function readJobs(home: string): Promise<ListedJobStatus[]> {
  const directory = path.join(home, "jobs");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") names = [];
    else throw error;
  }
  const statuses: JobStatus[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith(".json")).sort()) {
    try {
      statuses.push(JSON.parse(await readFile(path.join(directory, name), "utf8")) as JobStatus);
    } catch (error) {
      throw new CueLineError("JOB_STATUS_INVALID", `unable to parse job status: ${name}`, {
        cause: error,
      });
    }
  }
  const runMetadata = await readRunJobMetadata(home);
  const persistedById = new Map(statuses.map((status) => [status.jobId, status]));
  for (const [jobId, metadata] of runMetadata) {
    if (!persistedById.has(jobId)) statuses.push(metadata);
  }
  const ownership = new Map<string, Awaited<ReturnType<typeof readRuntimeLease>>>();
  const listed: ListedJobStatus[] = [];
  for (const persisted of statuses) {
    const authoritative = runMetadata.get(persisted.jobId);
    const conflict = authoritative !== undefined && authoritative.status !== persisted.status;
    const status: RunJobMetadata = conflict
      ? {
          ...Object.fromEntries(
            Object.entries(persisted).filter(
              ([key]) => key !== "result" && key !== "error" && key !== "finishedAt",
            ),
          ),
          ...authoritative,
          execution: persisted.execution,
          startedAt: persisted.startedAt,
        } as RunJobMetadata
      : {
          ...authoritative,
          ...persisted,
          status: authoritative?.status ?? persisted.status,
        };
    let observedStatus: ObservedJobStatus = conflict ? "conflict" : status.status;
    if (!conflict && status.status === "running") {
      if (status.runId === undefined) {
        observedStatus = "unverified";
      } else {
        let runtime = ownership.get(status.runId);
        if (runtime === undefined) {
          runtime = await readRuntimeLease(home, status.runId);
          ownership.set(status.runId, runtime);
        }
        observedStatus = runtime.ownership === "active" ? "running" : "orphaned";
      }
    }
    listed.push({
      ...status,
      ...(conflict ? { persistedStatus: persisted.status } : {}),
      observedStatus,
    });
  }
  return listed.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

async function jobsCommand(
  json: boolean,
  environment: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  const jobs = await readJobs(defaultCueLineHome(environment));
  if (json) {
    io.stdout(JSON.stringify(jobs, null, 2));
    return 0;
  }
  if (jobs.length === 0) {
    io.stdout("No jobs.");
    return 0;
  }
  for (const job of jobs) {
    io.stdout(
      `${job.jobId}\t${job.runId ?? "-"}\t${job.jobKey ?? "-"}\t${job.lane ?? "-"}\t${job.mode ?? "-"}\t${job.pid ?? "-"}\t${job.execution}\t${job.observedStatus}\t${job.startedAt}\trunner=${job.runnerId ?? "-"}\tmodel=${job.model ?? "-"}\tprovider=${job.provider ?? "-"}\tphase=${job.phase ?? "-"}\tprogress=${job.lastProgressAt ?? "-"}\ttask=${JSON.stringify(job.task ?? "")}`,
    );
  }
  return 0;
}

async function runStatusCommand(
  runId: string,
  json: boolean,
  environment: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  const status = await loadCueLineRunStatus(runId, { environment });
  if (json) {
    io.stdout(JSON.stringify({ version: CUELINE_VERSION, ...status }, null, 2));
    return 0;
  }
  const controller = status.controller.responseAccepted
    ? "response_accepted"
    : status.controller.pendingTurns > 0
      ? "response_pending"
      : "no_response_accepted";
  const counts = status.jobs.counts;
  io.stdout(`run\t${status.runId}`);
  io.stdout(`version\t${CUELINE_VERSION}`);
  io.stdout(`status\t${status.status}`);
  io.stdout(`executor\t${status.executor}`);
  io.stdout(`process_authorized\t${status.allowProcessExecution ? "yes" : "no"}`);
  io.stdout(`phase\t${status.phase}`);
  io.stdout(
    `runtime\t${status.runtime.ownership}${
      status.runtime.heartbeatAt === undefined
        ? ""
        : `\theartbeat=${status.runtime.heartbeatAt}\tage_ms=${status.runtime.ageMs ?? "-"}`
    }`,
  );
  io.stdout(`sequence\t${status.lastEventSequence}`);
  io.stdout(
    `controller\t${controller}\tpending=${status.controller.pendingTurns}\taccepted_commands=${status.controller.acceptedCommands}\tlast_action=${status.controller.lastAcceptedAction ?? "-"}\tlast_jobs=${status.controller.lastAcceptedJobKeys.length}`,
  );
  io.stdout(
    `jobs\ttotal=${status.jobs.total}\tpending=${counts.pending}\trunning=${counts.running}\tsucceeded=${counts.succeeded}\tfailed=${counts.failed}\ttimed_out=${counts.timed_out}\torphaned=${counts.orphaned}\tcancelled=${counts.cancelled}\tambiguous=${counts.ambiguous}`,
  );
  for (const job of status.jobs.items) {
    io.stdout(
      `job\t${job.jobId}\t${job.jobKey}\t${job.status}\t${job.mode}\t${job.lane}\trequired=${job.required}\tpersisted=${job.persistedStatus}\trunner=${job.execution?.runnerId ?? "-"}\tpid=${job.execution?.pid ?? "-"}\tmodel=${job.execution?.model ?? "-"}\tprovider=${job.execution?.provider ?? "-"}\tphase=${job.execution?.phase ?? "-"}\tprogress=${job.execution?.lastProgressAt ?? "-"}\ttask=${JSON.stringify(job.task)}`,
    );
  }
  io.stdout(
    `cancellation\trun=${status.cancellation.runRequested ? "requested" : "none"}\tjobs=${status.cancellation.jobRequests.length}`,
  );
  io.stdout(`continue\t${status.continueAllowed ? "allowed" : "forbidden"}`);
  io.stdout(`next\t${status.safeNextAction}`);
  return 0;
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

async function doctorCommand(environment: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const configPath = routingConfigPath(environment);
  const home = defaultCueLineHome(environment);
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  const nodeOk = major >= 22;
  const config = await loadRoutingConfig(configPath);
  const availability = executableAvailability(environment);
  let callerLanes = 0;
  let processAvailableLanes = 0;
  for (const [lane, laneConfig] of Object.entries(config.lanes)) {
    if (!laneConfig.enabled) continue;
    callerLanes += 1;
    try {
      resolveRoute(lane, config, availability);
      processAvailableLanes += 1;
    } catch {
      // Doctor reports the aggregate below; `cueline routing` shows lane details.
    }
  }
  const callerReady = nodeOk && callerLanes > 0;
  io.stdout(`CueLine ${CUELINE_VERSION}`);
  io.stdout(`status\t${callerReady ? "ok" : "degraded"}`);
  io.stdout(`node\t${process.versions.node}\t${nodeOk ? "ok" : "requires >=22"}`);
  io.stdout(`config\t${configPath}\tvalid`);
  io.stdout(`home\t${home}`);
  io.stdout(`caller_ready\t${callerReady ? "yes" : "no"}`);
  io.stdout(`caller_lanes\t${callerLanes}`);
  io.stdout(`process_available_lanes\t${processAvailableLanes}`);
  return callerReady ? 0 : 1;
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
  io: CliIo = processIo,
): Promise<number> {
  try {
    if (args.length === 0) {
      io.stdout(help());
      return 0;
    }
    if (args.length === 1 && ["help", "--help", "-h"].includes(args[0] as string)) {
      io.stdout(help());
      return 0;
    }
    if (
      args.length > 1 &&
      args.some((argument) => argument === "--help" || argument === "-h")
    ) {
      io.stdout(help());
      return 0;
    }
    if (args.length === 1 && ["version", "--version", "-v"].includes(args[0] as string)) {
      io.stdout(CUELINE_VERSION);
      return 0;
    }
    if (args[0] === "config" && args[1] === "path" && args.length === 2) {
      io.stdout(routingConfigPath(environment));
      return 0;
    }
    if (args[0] === "api" && args[1] === "path" && args.length === 2) {
      io.stdout(fileURLToPath(new URL("../api.js", import.meta.url)));
      return 0;
    }
    if (args[0] === "install" && args.length === 1) {
      io.stdout(await installSkill(environment));
      return 0;
    }
    if (args[0] === "uninstall" && args.length === 1) {
      io.stdout(await uninstallSkill(environment));
      return 0;
    }
    if (args[0] === "routing" && args.length === 1) {
      return routingCommand(environment, io);
    }
    if (
      args[0] === "jobs" &&
      (args.length === 1 || (args.length === 2 && args[1] === "--json"))
    ) {
      return jobsCommand(args[1] === "--json", environment, io);
    }
    if (
      args[0] === "run" &&
      args[1] === "takeover" &&
      typeof args[2] === "string" &&
      (args.length === 3 || (args.length === 4 && args[3] === "--json"))
    ) {
      const result = await takeoverCueLineRuntime(args[2], { environment });
      if (args[3] === "--json") io.stdout(JSON.stringify(result, null, 2));
      else {
        io.stdout(
          `${result.runId}\t${result.outcome}\tnext=${result.next}${
            result.previousOwnerId === undefined
              ? ""
              : `\tprevious_owner=${result.previousOwnerId}`
          }`,
        );
      }
      return 0;
    }
    if (
      args[0] === "run" &&
      args[1] === "reconcile-runtime" &&
      typeof args[2] === "string" &&
      (args.length === 3 || (args.length === 4 && args[3] === "--json"))
    ) {
      const result = await reconcileCueLineRuntime(args[2], { environment });
      if (args[3] === "--json") io.stdout(JSON.stringify(result, null, 2));
      else {
        io.stdout(
          `${result.runId}\t${result.outcome}\taffected_jobs=${result.affectedJobs}\tsurviving_jobs=${result.survivingJobs.length}`,
        );
      }
      return result.outcome === "owner_alive" || result.outcome === "processes_alive" ? 1 : 0;
    }
    if (
      args[0] === "run" &&
      args[1] === "reconcile" &&
      typeof args[2] === "string"
    ) {
      let requestId: string | undefined;
      let conversationUrl: string | undefined;
      let manualConfirmed = false;
      let json = false;
      let valid = true;
      for (let index = 3; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--request-id" && typeof args[index + 1] === "string") {
          requestId = args[index + 1];
          index += 1;
        } else if (
          argument === "--conversation-url" &&
          typeof args[index + 1] === "string"
        ) {
          conversationUrl = args[index + 1];
          index += 1;
        } else if (argument === "--manual-send-confirmed") {
          manualConfirmed = true;
        } else if (argument === "--json") {
          json = true;
        } else {
          valid = false;
        }
      }
      if (!valid || !requestId || !manualConfirmed) {
        throw new CueLineError(
          "CLI_ARGUMENTS_INVALID",
          "usage: cueline run reconcile <run-id> --request-id <request-id> --manual-send-confirmed [--conversation-url <url>] [--json]",
        );
      }
      const result = await confirmManualControllerSubmission(args[2], {
        environment,
        requestId,
        ...(conversationUrl === undefined ? {} : { conversationUrl }),
      });
      if (json) io.stdout(JSON.stringify(result, null, 2));
      else io.stdout(`${result.runId}\t${result.requestId}\t${result.outcome}\tno_resend`);
      return 0;
    }
    if (
      args[0] === "run" &&
      args[1] === "watch" &&
      typeof args[2] === "string"
    ) {
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
      return runWatchCommand(
        args[2],
        afterSequence,
        timeoutMs,
        json,
        environment,
        io,
      );
    }
    if (
      args[0] === "run" &&
      args[1] === "status" &&
      typeof args[2] === "string" &&
      (args.length === 3 || (args.length === 4 && args[3] === "--json"))
    ) {
      return runStatusCommand(args[2], args[3] === "--json", environment, io);
    }
    if (
      args[0] === "run" &&
      (args[1] === "cancel" || args[1] === "stop") &&
      typeof args[2] === "string" &&
      (args.length === 3 || (args.length === 4 && args[3] === "--json"))
    ) {
      const result = await cancelCueLineRun(args[2], {
        environment,
        reason: `operator requested ${args[1]} via CLI`,
      });
      if (args[3] === "--json") io.stdout(JSON.stringify(result, null, 2));
      else io.stdout(`${result.runId}\t${result.outcome}\taffected_jobs=${result.affectedJobs}`);
      return 0;
    }
    if (
      args[0] === "job" &&
      args[1] === "cancel" &&
      typeof args[2] === "string" &&
      typeof args[3] === "string" &&
      (args.length === 4 || (args.length === 5 && args[4] === "--json"))
    ) {
      const result = await cancelCueLineJob(args[2], args[3], {
        environment,
        reason: "operator requested job cancellation via CLI",
      });
      if (args[4] === "--json") io.stdout(JSON.stringify(result, null, 2));
      else io.stdout(`${result.runId}\t${result.jobId}\t${result.outcome}`);
      return 0;
    }
    if (args[0] === "doctor" && args.length === 1) {
      return doctorCommand(environment, io);
    }
    io.stderr(`cueline: unrecognized command: ${args.join(" ")}`);
    io.stderr(usage());
    io.stderr("try `cueline help`");
    return 2;
  } catch (error) {
    io.stderr(`CueLine: ${errorMessage(error)}`);
    return error instanceof CueLineError && error.code === "CLI_ARGUMENTS_INVALID" ? 2 : 1;
  }
}

if (
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  process.exitCode = await main();
}
