import { lstat } from "node:fs/promises";

import { listCueLineRuns, routingConfigPath } from "../api.js";
import { loadRoutingConfig } from "../router/config-loader.js";
import { defaultCueLineHome } from "../state/paths.js";
import { CUELINE_VERSION } from "../version.js";

export type UpgradePreflightSurface = "version" | "node" | "config" | "state" | "runs";

export interface UpgradePreflightFinding {
  code: string;
  severity: "blocker" | "warning";
  surface: UpgradePreflightSurface;
  message: string;
}

export interface UpgradePreflightReport {
  schema: "cueline-upgrade-preflight/1";
  version: string;
  targetVersion: string;
  status: "ready" | "blocked";
  checks: {
    node: { version: string; requirement: ">=22"; ok: boolean };
    config: { path: string; valid: boolean };
    stateHome: {
      path: string;
      kind: "missing" | "directory" | "symlink" | "other";
      private: boolean | null;
    };
    runs: { total: number; nonTerminal: number; unreadable: number };
  };
  findings: UpgradePreflightFinding[];
}

export interface UpgradePreflightOptions {
  targetVersion: string;
  environment?: NodeJS.ProcessEnv;
  nodeVersion?: string;
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseStableVersion(value: string): ParsedVersion | undefined {
  const match = STABLE_SEMVER.exec(value);
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersion(left: ParsedVersion, right: ParsedVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export async function collectUpgradePreflight(
  options: UpgradePreflightOptions,
): Promise<UpgradePreflightReport> {
  const environment = options.environment ?? process.env;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const targetVersion = options.targetVersion;
  const configPath = routingConfigPath(environment);
  const home = defaultCueLineHome(environment);
  const findings: UpgradePreflightFinding[] = [];

  const current = parseStableVersion(CUELINE_VERSION);
  const target = parseStableVersion(targetVersion);
  if (target === undefined) {
    findings.push({
      code: "TARGET_VERSION_INVALID",
      severity: "blocker",
      surface: "version",
      message: "Target version must be a stable semantic version such as 1.0.0.",
    });
  } else if (current !== undefined && compareVersion(target, current) < 0) {
    findings.push({
      code: "TARGET_VERSION_DOWNGRADE",
      severity: "blocker",
      surface: "version",
      message: "Upgrade preflight does not authorize a downgrade.",
    });
  } else if (current !== undefined && compareVersion(target, current) === 0) {
    findings.push({
      code: "TARGET_VERSION_NOT_NEWER",
      severity: "warning",
      surface: "version",
      message: "Target version is already installed.",
    });
  }

  const nodeMajor = Number.parseInt(nodeVersion.split(".")[0] ?? "0", 10);
  const nodeOk = Number.isSafeInteger(nodeMajor) && nodeMajor >= 22;
  if (!nodeOk) {
    findings.push({
      code: "NODE_VERSION_UNSUPPORTED",
      severity: "blocker",
      surface: "node",
      message: "Node.js 22 or newer is required before upgrading CueLine.",
    });
  }

  let configValid = true;
  try {
    await loadRoutingConfig(configPath);
  } catch {
    configValid = false;
    findings.push({
      code: "ROUTING_CONFIG_INVALID",
      severity: "blocker",
      surface: "config",
      message: "The active routing configuration cannot be loaded by this version.",
    });
  }

  let stateKind: UpgradePreflightReport["checks"]["stateHome"]["kind"] = "missing";
  let statePrivate: boolean | null = null;
  try {
    const state = await lstat(home);
    if (state.isSymbolicLink()) {
      stateKind = "symlink";
      findings.push({
        code: "STATE_HOME_SYMLINK_UNSAFE",
        severity: "blocker",
        surface: "state",
        message: "CueLine state home is a symbolic link; resolve it explicitly before upgrading.",
      });
    } else if (state.isDirectory()) {
      stateKind = "directory";
      statePrivate = (state.mode & 0o077) === 0;
      if (!statePrivate) {
        findings.push({
          code: "STATE_HOME_PERMISSIONS_UNSAFE",
          severity: "blocker",
          surface: "state",
          message: "CueLine state home grants group or other permissions.",
        });
      }
    } else {
      stateKind = "other";
      findings.push({
        code: "STATE_HOME_NOT_DIRECTORY",
        severity: "blocker",
        surface: "state",
        message: "CueLine state home exists but is not a directory.",
      });
    }
  } catch (error) {
    if (!isNotFound(error)) {
      stateKind = "other";
      findings.push({
        code: "STATE_HOME_UNREADABLE",
        severity: "blocker",
        surface: "state",
        message: "CueLine state home metadata cannot be read.",
      });
    }
  }

  let totalRuns = 0;
  let nonTerminalRuns = 0;
  let unreadableRuns = 0;
  if (stateKind === "missing" || (stateKind === "directory" && statePrivate === true)) {
    try {
      const runs = await listCueLineRuns({ home, environment });
      totalRuns = runs.length;
      unreadableRuns = runs.filter((run) => !run.readable).length;
      nonTerminalRuns = runs.filter(
        (run) =>
          run.readable &&
          run.status !== "complete" &&
          run.status !== "blocked" &&
          run.status !== "cancelled",
      ).length;
      if (unreadableRuns > 0) {
        findings.push({
          code: "RUN_EVIDENCE_UNREADABLE",
          severity: "blocker",
          surface: "runs",
          message: "At least one persisted run cannot be read safely.",
        });
      }
      if (nonTerminalRuns > 0) {
        findings.push({
          code: "NON_TERMINAL_RUNS_PRESENT",
          severity: "blocker",
          surface: "runs",
          message: "Finish, block, or cancel every persisted run before upgrading.",
        });
      }
    } catch {
      findings.push({
        code: "RUN_STORE_UNREADABLE",
        severity: "blocker",
        surface: "runs",
        message: "The persisted run store cannot be inspected safely.",
      });
    }
  }

  return {
    schema: "cueline-upgrade-preflight/1",
    version: CUELINE_VERSION,
    targetVersion,
    status: findings.some((finding) => finding.severity === "blocker")
      ? "blocked"
      : "ready",
    checks: {
      node: { version: nodeVersion, requirement: ">=22", ok: nodeOk },
      config: { path: configPath, valid: configValid },
      stateHome: { path: home, kind: stateKind, private: statePrivate },
      runs: { total: totalRuns, nonTerminal: nonTerminalRuns, unreadable: unreadableRuns },
    },
    findings,
  };
}
