import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runCueLine } from "../api.js";
import { verifyCueLineRun } from "../api-run-verification.js";
import type {
  BrowserAdapter,
  BrowserTurnInput,
  ControllerTurn,
} from "../browser/browser-adapter.js";
import { CueLineError } from "../core/errors.js";
import type { RoutingConfig } from "../router/types.js";
import { CUELINE_VERSION } from "../version.js";

export interface OfflineSelfTestFinding {
  code: string;
  message: string;
}

export interface OfflineSelfTestReport {
  schema: "cueline-offline-self-test/1";
  version: string;
  status: "ok" | "failed";
  offline: true;
  checks: {
    controllerRounds: number;
    completedJobs: number;
    finalDelivery: boolean;
    durableRunVerification: boolean;
  };
  findings: OfflineSelfTestFinding[];
}

const EMPTY_CHECKS: OfflineSelfTestReport["checks"] = {
  controllerRounds: 0,
  completedJobs: 0,
  finalDelivery: false,
  durableRunVerification: false,
};

function controlReply(
  input: BrowserTurnInput,
  command: Record<string, unknown>,
): ControllerTurn {
  return {
    text: `<CueLineControl>${JSON.stringify({
      protocol: "cueline/0.1",
      run_id: input.runId,
      round: input.round,
      request_id: input.requestId,
      ...command,
    })}</CueLineControl>`,
    conversationUrl: "https://chatgpt.com/c/cueline-offline-self-test",
    model: {
      provider: "chatgpt",
      selectedLabel: "Pro",
      responseModelSlug: "gpt-5-6-pro",
      source: "composer_and_response",
    },
  };
}

class OfflineController implements BrowserAdapter {
  rounds = 0;

  async sendTurn(input: BrowserTurnInput): Promise<ControllerTurn> {
    this.rounds += 1;
    if (this.rounds === 1) {
      if (!input.prompt.includes("offline [node-offline-self-test]")) {
        throw new CueLineError(
          "SELF_TEST_ROUTING_PROMPT_MISSING",
          "The controller prompt did not expose the isolated offline lane.",
        );
      }
      return controlReply(input, {
        action: "dispatch",
        jobs: [
          {
            job_key: "offline-worker",
            lane: "offline",
            mode: "advise",
            task: "CUELINE_OFFLINE_WORKER_OK",
            required: true,
          },
        ],
      });
    }
    if (this.rounds === 2) {
      if (!input.prompt.includes("WORKER:CUELINE_OFFLINE_WORKER_OK")) {
        throw new CueLineError(
          "SELF_TEST_WORKER_EVIDENCE_MISSING",
          "The controller did not receive the isolated worker evidence.",
        );
      }
      return controlReply(input, {
        action: "complete",
        final_delivery_text: "CUELINE_OFFLINE_SELF_TEST_OK",
      });
    }
    throw new CueLineError(
      "SELF_TEST_CONTROLLER_ROUNDS_EXCEEDED",
      "The isolated controller requested an unexpected extra round.",
    );
  }
}

function failedReport(code: string, message: string): OfflineSelfTestReport {
  return {
    schema: "cueline-offline-self-test/1",
    version: CUELINE_VERSION,
    status: "failed",
    offline: true,
    checks: { ...EMPTY_CHECKS },
    findings: [{ code, message }],
  };
}

/**
 * Exercises the public controller loop with only an in-memory controller and
 * the current Node executable. All durable state lives below two fresh temp
 * directories and is removed before this function returns.
 */
export async function runOfflineSelfTest(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<OfflineSelfTestReport> {
  if (environment.CUELINE_DEPTH !== undefined) {
    return failedReport(
      "NESTED_ROUTING_REJECTED",
      "Offline self-test cannot run from inside another CueLine execution.",
    );
  }

  let home: string | undefined;
  let workspace: string | undefined;
  try {
    home = await mkdtemp(path.join(tmpdir(), "cueline-offline-self-test-home-"));
    workspace = await mkdtemp(path.join(tmpdir(), "cueline-offline-self-test-workspace-"));
    const controller = new OfflineController();
    const routingConfig: RoutingConfig = {
      version: 1,
      lanes: {
        offline: {
          enabled: true,
          candidates: [
            {
              id: "node-offline-self-test",
              argv: [
                process.execPath,
                "-e",
                "process.stdin.setEncoding('utf8'); let data=''; process.stdin.on('data', chunk => data += chunk); process.stdin.on('end', () => process.stdout.write('WORKER:' + data));",
              ],
              task_input: "stdin",
            },
          ],
        },
      },
    };
    const runId = `run_offline_self_test_${process.pid}_${Date.now()}`;
    const result = await runCueLine({
      executor: "process",
      allowProcessExecution: true,
      request: "Verify the installed CueLine controller loop offline.",
      runId,
      home,
      cwd: workspace,
      browser: controller,
      routingConfig,
      environment: { ...environment },
      maxRounds: 2,
    });
    const verification = await verifyCueLineRun(runId, { home, environment });
    const completedJobs = Object.values(result.state.jobs).filter(
      (job) => job.runtime?.phase === "completed",
    ).length;
    const checks: OfflineSelfTestReport["checks"] = {
      controllerRounds: controller.rounds,
      completedJobs,
      finalDelivery:
        result.status === "complete" &&
        result.finalDeliveryText === "CUELINE_OFFLINE_SELF_TEST_OK",
      durableRunVerification: verification.outcome === "verified",
    };
    const ok =
      checks.controllerRounds === 2 &&
      checks.completedJobs === 1 &&
      checks.finalDelivery &&
      checks.durableRunVerification;
    return {
      schema: "cueline-offline-self-test/1",
      version: CUELINE_VERSION,
      status: ok ? "ok" : "failed",
      offline: true,
      checks,
      findings: ok
        ? []
        : [
            {
              code: "SELF_TEST_INVARIANT_FAILED",
              message: "One or more isolated controller-loop invariants did not pass.",
            },
          ],
    };
  } catch (error) {
    return failedReport(
      error instanceof CueLineError ? error.code : "SELF_TEST_EXECUTION_FAILED",
      error instanceof CueLineError
        ? error.message
        : "The isolated controller loop did not complete.",
    );
  } finally {
    await Promise.all([
      ...(home === undefined ? [] : [rm(home, { recursive: true, force: true })]),
      ...(workspace === undefined ? [] : [rm(workspace, { recursive: true, force: true })]),
    ]);
  }
}
