import { routingConfigPath } from "../api.js";
import { CueLineError } from "../core/errors.js";
import { executableAvailability } from "../router/availability.js";
import { loadRoutingConfig } from "../router/config-loader.js";
import { explainRoutingConfig, type RoutingExplanation } from "../router/explain.js";
import { resolveRoute } from "../router/resolver.js";
import { defaultCueLineHome } from "../state/paths.js";
import { CUELINE_VERSION } from "../version.js";
import type { CliIo } from "./io.js";

interface RoutingLaneReport {
  name: string;
  enabled: boolean;
  status: "available" | "unavailable" | "disabled";
  selectedRunnerId: string | null;
  errorCode?: string;
}

interface RoutingReport {
  version: string;
  config:
    | { path: string; valid: true }
    | { path: string; valid: false; errorCode: "ROUTING_CONFIG_INVALID" };
  availableLanes: number;
  lanes: RoutingLaneReport[];
  findings: Array<{ code: string; message: string }>;
}

interface RoutingExplanationReport extends RoutingExplanation {
  schema: "cueline-routing-explain/0.1";
  version: string;
  config:
    | { path: string; valid: true }
    | { path: string; valid: false; errorCode: "ROUTING_CONFIG_INVALID" };
}

interface DoctorFinding {
  code: string;
  surface: "node" | "config" | "caller";
  message: string;
}

interface DoctorReport {
  version: string;
  status: "ok" | "degraded";
  node: {
    version: string;
    ok: boolean;
    requirement: ">=22";
  };
  config:
    | { path: string; valid: true }
    | { path: string; valid: false; errorCode: "ROUTING_CONFIG_INVALID" };
  home: string;
  caller: {
    ready: boolean;
    enabledLanes: number;
  };
  process: {
    availableLanes: number;
  };
  findings: DoctorFinding[];
}

function routingErrorCode(error: unknown): string {
  return error instanceof CueLineError ? error.code : "ROUTE_UNAVAILABLE";
}

async function collectRoutingReport(environment: NodeJS.ProcessEnv): Promise<RoutingReport> {
  const configPath = routingConfigPath(environment);
  let config: Awaited<ReturnType<typeof loadRoutingConfig>>;
  try {
    config = await loadRoutingConfig(configPath);
  } catch {
    return {
      version: CUELINE_VERSION,
      config: {
        path: configPath,
        valid: false,
        errorCode: "ROUTING_CONFIG_INVALID",
      },
      availableLanes: 0,
      lanes: [],
      findings: [
        {
          code: "ROUTING_CONFIG_INVALID",
          message: "Routing configuration could not be loaded.",
        },
      ],
    };
  }
  const availability = executableAvailability(environment);
  const lanes: RoutingLaneReport[] = [];
  for (const [lane, laneConfig] of Object.entries(config.lanes)) {
    if (!laneConfig.enabled) {
      lanes.push({
        name: lane,
        enabled: false,
        status: "disabled",
        selectedRunnerId: null,
      });
      continue;
    }
    try {
      const route = resolveRoute(lane, config, availability);
      lanes.push({
        name: lane,
        enabled: true,
        status: "available",
        selectedRunnerId: route.candidate.id,
      });
    } catch (error) {
      lanes.push({
        name: lane,
        enabled: true,
        status: "unavailable",
        selectedRunnerId: null,
        errorCode: routingErrorCode(error),
      });
    }
  }
  return {
    version: CUELINE_VERSION,
    config: { path: configPath, valid: true },
    availableLanes: lanes.filter((lane) => lane.status === "available").length,
    lanes,
    findings: [],
  };
}

async function routingCommand(
  json: boolean,
  environment: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  const report = await collectRoutingReport(environment);
  if (json) {
    io.stdout(JSON.stringify(report, null, 2));
  } else if (!report.config.valid) {
    io.stdout(`config\t${report.config.path}\tinvalid\t${report.config.errorCode}`);
  } else {
    for (const lane of report.lanes) {
      io.stdout(
        `${lane.name}\t${lane.selectedRunnerId ?? "-"}\t${lane.status}${
          lane.errorCode === undefined ? "" : ` (${lane.errorCode})`
        }`,
      );
    }
  }
  return report.availableLanes > 0 ? 0 : 1;
}

async function collectRoutingExplanation(
  requestedLane: string | undefined,
  environment: NodeJS.ProcessEnv,
): Promise<RoutingExplanationReport> {
  const configPath = routingConfigPath(environment);
  try {
    const config = await loadRoutingConfig(configPath);
    return {
      schema: "cueline-routing-explain/0.1",
      version: CUELINE_VERSION,
      config: { path: configPath, valid: true },
      ...explainRoutingConfig(config, executableAvailability(environment), requestedLane),
    };
  } catch {
    return {
      schema: "cueline-routing-explain/0.1",
      version: CUELINE_VERSION,
      config: { path: configPath, valid: false, errorCode: "ROUTING_CONFIG_INVALID" },
      requestedLane: requestedLane ?? null,
      availableLanes: 0,
      lanes: [],
      findings: [
        {
          code: "ROUTING_CONFIG_INVALID",
          message: "Routing configuration could not be loaded.",
        },
      ],
    };
  }
}

async function routingExplainCommand(
  requestedLane: string | undefined,
  json: boolean,
  environment: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  const report = await collectRoutingExplanation(requestedLane, environment);
  if (json) {
    io.stdout(JSON.stringify(report, null, 2));
  } else if (!report.config.valid) {
    io.stdout(`config\t${report.config.path}\tinvalid\t${report.config.errorCode}`);
  } else if (report.findings.length > 0) {
    for (const finding of report.findings) io.stdout(`finding\t${finding.code}\t${finding.message}`);
  } else {
    for (const lane of report.lanes) {
      io.stdout(`${lane.name}\t${lane.selectedRunnerId ?? "-"}\t${lane.status}`);
      for (const candidate of lane.candidates) {
        io.stdout(
          `candidate\t${candidate.index}\t${candidate.id}\t${candidate.reasonCode}`,
        );
      }
    }
  }
  return report.availableLanes > 0 ? 0 : 1;
}

async function collectDoctorReport(environment: NodeJS.ProcessEnv): Promise<DoctorReport> {
  const configPath = routingConfigPath(environment);
  const home = defaultCueLineHome(environment);
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  const nodeOk = major >= 22;
  const availability = executableAvailability(environment);
  const findings: DoctorFinding[] = [];
  let callerLanes = 0;
  let processAvailableLanes = 0;
  let config: Awaited<ReturnType<typeof loadRoutingConfig>> | undefined;
  try {
    config = await loadRoutingConfig(configPath);
  } catch {
    findings.push({
      code: "ROUTING_CONFIG_INVALID",
      surface: "config",
      message: "Routing configuration could not be loaded.",
    });
  }
  if (config !== undefined) {
    for (const [lane, laneConfig] of Object.entries(config.lanes)) {
      if (!laneConfig.enabled) continue;
      callerLanes += 1;
      try {
        resolveRoute(lane, config, availability);
        processAvailableLanes += 1;
      } catch {
        // `cueline routing` reports per-lane details.
      }
    }
  }
  if (!nodeOk) {
    findings.push({
      code: "NODE_VERSION_UNSUPPORTED",
      surface: "node",
      message: "Node.js 22 or newer is required.",
    });
  }
  if (config !== undefined && callerLanes === 0) {
    findings.push({
      code: "CALLER_LANES_UNAVAILABLE",
      surface: "caller",
      message: "No enabled caller lane is configured.",
    });
  }
  const callerReady = nodeOk && config !== undefined && callerLanes > 0;
  return {
    version: CUELINE_VERSION,
    status: callerReady ? "ok" : "degraded",
    node: {
      version: process.versions.node,
      ok: nodeOk,
      requirement: ">=22",
    },
    config:
      config === undefined
        ? { path: configPath, valid: false, errorCode: "ROUTING_CONFIG_INVALID" }
        : { path: configPath, valid: true },
    home,
    caller: {
      ready: callerReady,
      enabledLanes: callerLanes,
    },
    process: {
      availableLanes: processAvailableLanes,
    },
    findings,
  };
}

async function doctorCommand(
  json: boolean,
  environment: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number> {
  const report = await collectDoctorReport(environment);
  if (json) {
    io.stdout(JSON.stringify(report, null, 2));
  } else {
    io.stdout(`CueLine ${report.version}`);
    io.stdout(`status\t${report.status}`);
    io.stdout(
      `node\t${report.node.version}\t${report.node.ok ? "ok" : `requires ${report.node.requirement}`}`,
    );
    io.stdout(`config\t${report.config.path}\t${report.config.valid ? "valid" : "invalid"}`);
    io.stdout(`home\t${report.home}`);
    io.stdout(`caller_ready\t${report.caller.ready ? "yes" : "no"}`);
    io.stdout(`caller_lanes\t${report.caller.enabledLanes}`);
    io.stdout(`process_available_lanes\t${report.process.availableLanes}`);
    for (const item of report.findings) {
      io.stdout(`finding\t${item.code}\t${item.surface}\t${item.message}`);
    }
  }
  return report.status === "ok" ? 0 : 1;
}

export async function handleHealthCommand(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<number | undefined> {
  if (args[0] === "routing" && args[1] === "explain") {
    let requestedLane: string | undefined;
    let json = false;
    let valid = true;
    for (let index = 2; index < args.length; index += 1) {
      const argument = args[index];
      if (argument === "--json" && !json) {
        json = true;
      } else if (
        typeof argument === "string" &&
        !argument.startsWith("-") &&
        requestedLane === undefined
      ) {
        requestedLane = argument;
      } else {
        valid = false;
      }
    }
    if (!valid) {
      throw new CueLineError(
        "CLI_ARGUMENTS_INVALID",
        "usage: cueline routing explain [lane] [--json]",
      );
    }
    return routingExplainCommand(requestedLane, json, environment, io);
  }
  if (
    args[0] === "routing" &&
    (args.length === 1 || (args.length === 2 && args[1] === "--json"))
  ) {
    return routingCommand(args[1] === "--json", environment, io);
  }
  if (
    args[0] === "doctor" &&
    (args.length === 1 || (args.length === 2 && args[1] === "--json"))
  ) {
    return doctorCommand(args[1] === "--json", environment, io);
  }
  return undefined;
}
