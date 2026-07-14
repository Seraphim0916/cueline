#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  cancelCueLineJob,
  cancelCueLineRun,
  loadCueLineRunStatus,
  routingConfigPath,
} from "../api.js";
import { CueLineError } from "../core/errors.js";
import type { JobStatus } from "../jobs/status.js";
import { executableAvailability } from "../router/availability.js";
import { loadRoutingConfig } from "../router/config-loader.js";
import { resolveRoute } from "../router/resolver.js";
import { defaultCueLineHome } from "../state/paths.js";
import { readRuntimeLease } from "../state/runtime-lease.js";
import { readEvents } from "../state/event-log.js";
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
  return "usage: cueline <install|uninstall|doctor|routing|jobs|run status|run cancel|run stop|job cancel|api path|config path|help|version>";
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
    "  doctor         report Node, routing config, state home, and usable lanes",
    "  routing        list every lane and the candidate that would be selected",
    "  jobs           list persisted local jobs with run, key, lane, mode, and PID",
    "  run status     summarize one persisted run for safe cross-session handoff",
    "  run cancel     request safe cancellation; ownerless work becomes ambiguous",
    "  run stop       alias for `run cancel`",
    "  job cancel     request cancellation for one job in one run",
    "  api path       print the bundled API module path",
    "  config path    print the routing configuration file in effect",
    "  help           print this text",
    "  version        print the CueLine version",
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
    "These commands only diagnose the local installation. A live run is driven",
    "through the imported API inside Codex, where the built-in Browser lives.",
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

type ObservedJobStatus = JobStatus["status"] | "orphaned" | "unverified";
type ListedJobStatus = JobStatus & { observedStatus: ObservedJobStatus };

type LegacyJobMetadata = Pick<JobStatus, "runId" | "jobKey" | "lane" | "mode">;

async function readLegacyJobMetadata(home: string): Promise<Map<string, LegacyJobMetadata>> {
  const metadata = new Map<string, LegacyJobMetadata>();
  let entries;
  try {
    entries = await readdir(path.join(home, "runs"), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return metadata;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const events = await readEvents(path.join(home, "runs", entry.name, "events.jsonl"));
    for (const event of events) {
      if (
        event.type !== "job_registered" ||
        typeof event.payload !== "object" ||
        event.payload === null ||
        Array.isArray(event.payload)
      ) {
        continue;
      }
      const job = (event.payload as { job?: unknown }).job;
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
        (spec.mode !== "advise" && spec.mode !== "work")
      ) {
        continue;
      }
      metadata.set(record.jobId, {
        runId: entry.name,
        jobKey: record.jobKey,
        lane: spec.lane,
        mode: spec.mode,
      });
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
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
  const legacyMetadata = await readLegacyJobMetadata(home);
  const ownership = new Map<string, Awaited<ReturnType<typeof readRuntimeLease>>>();
  const listed: ListedJobStatus[] = [];
  for (const persisted of statuses) {
    const status: JobStatus = { ...legacyMetadata.get(persisted.jobId), ...persisted };
    let observedStatus: ObservedJobStatus = status.status;
    if (status.status === "running") {
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
    listed.push({ ...status, observedStatus });
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
      `${job.jobId}\t${job.runId ?? "-"}\t${job.jobKey ?? "-"}\t${job.lane ?? "-"}\t${job.mode ?? "-"}\t${job.pid ?? "-"}\t${job.execution}\t${job.observedStatus}\t${job.startedAt}`,
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
      `job\t${job.jobId}\t${job.jobKey}\t${job.status}\t${job.mode}\t${job.lane}\trequired=${job.required}\tpersisted=${job.persistedStatus}`,
    );
  }
  io.stdout(
    `cancellation\trun=${status.cancellation.runRequested ? "requested" : "none"}\tjobs=${status.cancellation.jobRequests.length}`,
  );
  io.stdout(`continue\t${status.continueAllowed ? "allowed" : "forbidden"}`);
  io.stdout(`next\t${status.safeNextAction}`);
  return 0;
}

async function doctorCommand(environment: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const configPath = routingConfigPath(environment);
  const home = defaultCueLineHome(environment);
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  const nodeOk = major >= 22;
  const config = await loadRoutingConfig(configPath);
  const availability = executableAvailability(environment);
  let availableLanes = 0;
  for (const [lane, laneConfig] of Object.entries(config.lanes)) {
    if (!laneConfig.enabled) continue;
    try {
      resolveRoute(lane, config, availability);
      availableLanes += 1;
    } catch {
      // Doctor reports the aggregate below; `cueline routing` shows lane details.
    }
  }
  const ok = nodeOk && availableLanes > 0;
  io.stdout(`CueLine ${CUELINE_VERSION}`);
  io.stdout(`status\t${ok ? "ok" : "degraded"}`);
  io.stdout(`node\t${process.versions.node}\t${nodeOk ? "ok" : "requires >=22"}`);
  io.stdout(`config\t${configPath}\tvalid`);
  io.stdout(`home\t${home}`);
  io.stdout(`available_lanes\t${availableLanes}`);
  return ok ? 0 : 1;
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
    return 1;
  }
}

if (
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  process.exitCode = await main();
}
