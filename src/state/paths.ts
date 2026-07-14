import path from "node:path";
import { homedir } from "node:os";

import { runtimeEnvironment } from "../core/runtime.js";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface RunPaths {
  home: string;
  runsDir: string;
  runDir: string;
  creationMarker: string;
  events: string;
  runtimeLease: string;
  runCancellation: string;
  jobCancellationsDir: string;
  snapshot: string;
}

export function defaultCueLineHome(environment: NodeJS.ProcessEnv = runtimeEnvironment()): string {
  const configured = environment.CUELINE_HOME;
  const userHome = environment.HOME ?? homedir();
  if (!configured || configured.trim() === "") {
    return path.resolve(userHome, ".cueline");
  }
  if (configured === "~") {
    return path.resolve(userHome);
  }
  if (/^~[/\\]/.test(configured)) {
    return path.resolve(userHome, configured.slice(2));
  }
  return path.resolve(configured);
}

export function runPaths(home: string, runId: string): RunPaths {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`RUN_ID_INVALID: '${runId}'`);
  }
  const resolvedHome = path.resolve(home);
  const runsDir = path.join(resolvedHome, "runs");
  const runDir = path.join(runsDir, runId);
  if (!runDir.startsWith(runsDir + path.sep)) {
    throw new Error(`RUN_ID_INVALID: '${runId}'`);
  }
  return {
    home: resolvedHome,
    runsDir,
    runDir,
    creationMarker: path.join(runDir, "created"),
    events: path.join(runDir, "events.jsonl"),
    runtimeLease: path.join(runDir, "runtime.json"),
    runCancellation: path.join(runDir, "cancel.json"),
    jobCancellationsDir: path.join(runDir, "job-cancellations"),
    snapshot: path.join(runDir, "snapshot.json"),
  };
}
