import { spawn, type ChildProcess } from "node:child_process";

import { CueLineError } from "../core/errors.js";
import { runtimeEnvironment } from "../core/runtime.js";
import type { JobResult, RunnerAdapter, RunnerSpec } from "./runner-adapter.js";
import { RunnerRegistry } from "./registry.js";

export interface ProcessRunnerOptions {
  environment?: NodeJS.ProcessEnv;
}

function combineOutput(stdout: string, stderr: string): string {
  if (stdout.length === 0) {
    return stderr;
  }
  if (stderr.length === 0) {
    return stdout;
  }
  return stdout.endsWith("\n") ? `${stdout}${stderr}` : `${stdout}\n${stderr}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Executes exactly one registered argv. Candidate fallback belongs to the
 * router and is intentionally unavailable here after a process starts.
 */
export class ProcessRunner implements RunnerAdapter {
  readonly #environment: NodeJS.ProcessEnv;

  constructor(
    private readonly registry: RunnerRegistry,
    options: ProcessRunnerOptions = {},
  ) {
    this.#environment = { ...(options.environment ?? runtimeEnvironment()) };
  }

  async run(spec: RunnerSpec): Promise<JobResult> {
    if (this.#environment.CUELINE_DEPTH !== undefined || spec.env?.CUELINE_DEPTH !== undefined) {
      throw new CueLineError("NESTED_ROUTING_REJECTED", "nested CueLine routing is not allowed");
    }
    if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0) {
      throw new CueLineError("PROCESS_TIMEOUT_INVALID", "process timeout must be a positive finite number", {
        details: { timeoutMs: spec.timeoutMs },
      });
    }

    const registered = this.registry.requireArgv(spec.argv);
    const executable = spec.argv[0];
    if (executable === undefined) {
      throw new CueLineError("RUNNER_ARGV_INVALID", "argv must begin with a registered executable");
    }
    if (registered.executable !== executable) {
      throw new CueLineError("RUNNER_EXECUTABLE_UNREGISTERED", "argv executable registration did not match");
    }

    return new Promise<JobResult>((resolve) => {
      const startedAt = new Date().toISOString();
      const environment: NodeJS.ProcessEnv = {
        ...this.#environment,
        ...spec.env,
        CUELINE_DEPTH: "1",
      };
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (status: JobResult["status"], exitCode: number | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutTimer !== undefined) {
          clearTimeout(timeoutTimer);
        }
        if (forceKillTimer !== undefined) {
          clearTimeout(forceKillTimer);
        }
        const output = combineOutput(stdout, stderr);
        resolve({
          status,
          exitCode,
          stdout,
          stderr,
          output,
          emptyOutput: output.length === 0,
          timedOut,
          ambiguousSideEffects: spec.mode === "work" && status !== "succeeded",
          retryable: false,
          startedAt,
          finishedAt: new Date().toISOString(),
        });
      };

      let child: ChildProcess;
      try {
        child = spawn(executable, [...spec.argv.slice(1)], {
          cwd: spec.cwd,
          env: environment,
          shell: false,
          stdio: [spec.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        });
      } catch (error) {
        stderr = errorText(error);
        finish("failed", null);
        return;
      }

      timeoutTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 250);
      }, spec.timeoutMs);

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string | Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string | Buffer) => {
        stderr += chunk.toString();
      });
      if (spec.stdin !== undefined) {
        child.stdin?.end(spec.stdin, "utf8");
      }
      child.once("error", (error) => {
        stderr += errorText(error);
        finish("failed", null);
      });
      child.once("close", (exitCode) => {
        finish(timedOut ? "timed_out" : exitCode === 0 ? "succeeded" : "failed", exitCode);
      });
    });
  }
}
