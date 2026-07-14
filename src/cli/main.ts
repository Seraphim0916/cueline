#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { routingConfigPath } from "../api.js";
import { CueLineError } from "../core/errors.js";
import type { JobStatus } from "../jobs/status.js";
import { executableAvailability } from "../router/availability.js";
import { loadRoutingConfig } from "../router/config-loader.js";
import { resolveRoute } from "../router/resolver.js";
import { defaultCueLineHome } from "../state/paths.js";
import { CUELINE_VERSION } from "../version.js";

interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const processIo: CliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

function usage(): string {
  return "usage: cueline <doctor|routing|jobs|config path|help|version>";
}

function help(): string {
  return [
    "CueLine — a ChatGPT web conversation directs; this machine executes.",
    "",
    usage(),
    "",
    "commands:",
    "  doctor         report Node, routing config, state home, and usable lanes",
    "  routing        list every lane and the candidate that would be selected",
    "  jobs           list persisted local jobs, oldest first",
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

async function readJobs(home: string): Promise<JobStatus[]> {
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
  return statuses.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

async function jobsCommand(environment: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const jobs = await readJobs(defaultCueLineHome(environment));
  if (jobs.length === 0) {
    io.stdout("No jobs.");
    return 0;
  }
  for (const job of jobs) {
    io.stdout(`${job.jobId}\t${job.execution}\t${job.status}\t${job.startedAt}`);
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
    if (args[0] === "routing" && args.length === 1) {
      return routingCommand(environment, io);
    }
    if (args[0] === "jobs" && args.length === 1) {
      return jobsCommand(environment, io);
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

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
