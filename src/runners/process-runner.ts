import { spawn, type ChildProcess } from "node:child_process";

import { CueLineError } from "../core/errors.js";
import { runtimeEnvironment } from "../core/runtime.js";
import type {
  JobResult,
  RunnerAdapter,
  RunnerRunHooks,
  RunnerSpec,
} from "./runner-adapter.js";
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

  async run(spec: RunnerSpec, hooks: RunnerRunHooks = {}): Promise<JobResult> {
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

    const startedAt = new Date().toISOString();
    if (spec.signal?.aborted) {
      const finishedAt = new Date().toISOString();
      return {
        status: "cancelled",
        exitCode: null,
        stdout: "",
        stderr: "",
        output: "",
        emptyOutput: true,
        timedOut: false,
        cancelled: true,
        ambiguousSideEffects: false,
        retryable: false,
        startedAt,
        finishedAt,
      };
    }

    let spawnedPid: number | undefined;
    let cancelSpawned: (() => void) | undefined;
    const completion = new Promise<JobResult>((resolve) => {
      const environment: NodeJS.ProcessEnv = {
        ...this.#environment,
        ...spec.env,
        CUELINE_DEPTH: "1",
      };
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let cancelled = false;
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
        spec.signal?.removeEventListener("abort", cancel);
        const output = combineOutput(stdout, stderr);
        resolve({
          status,
          exitCode,
          stdout,
          stderr,
          output,
          emptyOutput: output.length === 0,
          timedOut,
          cancelled,
          ambiguousSideEffects: spec.mode === "work" && status !== "succeeded",
          retryable: false,
          startedAt,
          finishedAt: new Date().toISOString(),
        });
      };

      let child: ChildProcess;
      const cancel = (): void => {
        if (settled || cancelled) return;
        cancelled = true;
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 250);
      };
      cancelSpawned = cancel;
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

      spawnedPid = child.pid;
      spec.signal?.addEventListener("abort", cancel, { once: true });

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
        finish(
          cancelled ? (spec.mode === "work" ? "ambiguous" : "cancelled") : "failed",
          null,
        );
      });
      child.once("close", (exitCode) => {
        finish(
          cancelled
            ? spec.mode === "work"
              ? "ambiguous"
              : "cancelled"
            : timedOut
              ? "timed_out"
              : exitCode === 0
                ? "succeeded"
                : "failed",
          exitCode,
        );
      });
    });
    if (spawnedPid !== undefined) {
      try {
        await hooks.onSpawn?.(spawnedPid);
      } catch (error) {
        cancelSpawned?.();
        await completion;
        throw error;
      }
    }
    return completion;
  }
}
