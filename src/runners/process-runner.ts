import { spawn, type ChildProcess } from "node:child_process";

import { CueLineError } from "../core/errors.js";
import { runtimeEnvironment, runtimePlatform } from "../core/runtime.js";
import { validatedTimerDelay } from "../core/timing.js";
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

const MAX_CAPTURED_STREAM_CHARS = 512_000;
const PROCESS_METADATA_CHARS = 16_384;

class BoundedTextCapture {
  readonly #headLimit: number;
  readonly #tailLimit: number;
  #head = "";
  #tail = "";
  #totalChars = 0;

  constructor(limit: number) {
    this.#headLimit = Math.ceil(limit / 2);
    this.#tailLimit = Math.floor(limit / 2);
  }

  append(value: string): void {
    this.#totalChars += value.length;
    const headSpace = this.#headLimit - this.#head.length;
    const headAddition = headSpace > 0 ? value.slice(0, headSpace) : "";
    this.#head += headAddition;
    const remainder = value.slice(headAddition.length);
    if (remainder !== "") {
      this.#tail = `${this.#tail}${remainder}`.slice(-this.#tailLimit);
    }
  }

  get truncatedChars(): number {
    return Math.max(0, this.#totalChars - this.#head.length - this.#tail.length);
  }

  get prefix(): string {
    return this.#head;
  }

  value(): string {
    const truncated = this.truncatedChars;
    if (truncated === 0) return `${this.#head}${this.#tail}`;
    return `${this.#head}\n...[truncated ${truncated} chars]...\n${this.#tail}`;
  }
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

function safeHeaderValue(value: string): string | undefined {
  const normalized = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/.test(normalized)
    ? normalized
    : undefined;
}

function processMetadata(header: string): { model?: string; provider?: string } {
  let model: string | undefined;
  let provider: string | undefined;
  for (const line of header.split(/\r?\n/)) {
    const modelMatch = /^model:\s*(.+)$/i.exec(line);
    if (model === undefined && modelMatch?.[1] !== undefined) {
      model = safeHeaderValue(modelMatch[1]);
    }
    const providerMatch = /^provider:\s*(.+)$/i.exec(line);
    if (provider === undefined && providerMatch?.[1] !== undefined) {
      provider = safeHeaderValue(providerMatch[1]);
    }
  }
  return {
    ...(model === undefined ? {} : { model }),
    ...(provider === undefined ? {} : { provider }),
  };
}

function nativeProcess(): NodeJS.Process | undefined {
  return typeof process === "undefined" ? undefined : process;
}

const SUPPORTS_PROCESS_GROUPS =
  runtimePlatform() !== "win32" && typeof nativeProcess()?.kill === "function";

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (SUPPORTS_PROCESS_GROUPS && child.pid !== undefined) {
    try {
      nativeProcess()!.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        return;
      }
    }
  }
  child.kill(signal);
}

function processTreeIsAlive(child: ChildProcess | undefined): boolean {
  if (!SUPPORTS_PROCESS_GROUPS || child?.pid === undefined) return false;
  try {
    nativeProcess()!.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code !== "ESRCH"
    );
  }
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
    validatedTimerDelay(spec.timeoutMs, {
      code: "PROCESS_TIMEOUT_INVALID",
      name: "process timeout",
    });

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
    let observedModel: string | undefined;
    let observedProvider: string | undefined;
    const emitProgress = (
      phase: string,
      metadata: { model?: string; provider?: string } = {},
    ): void => {
      try {
        void Promise.resolve(
          hooks.onProgress?.({
            phase,
            at: new Date().toISOString(),
            ...(metadata.model === undefined ? {} : { model: metadata.model }),
            ...(metadata.provider === undefined ? {} : { provider: metadata.provider }),
          }),
        ).catch(() => undefined);
      } catch {
        // Progress is diagnostic only and must never break process supervision.
      }
    };
    const completion = new Promise<JobResult>((resolve) => {
      const environment: NodeJS.ProcessEnv = {
        ...this.#environment,
        ...spec.env,
        CUELINE_DEPTH: "1",
      };
      const stdoutCapture = new BoundedTextCapture(MAX_CAPTURED_STREAM_CHARS);
      const stderrCapture = new BoundedTextCapture(MAX_CAPTURED_STREAM_CHARS);
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
      let child: ChildProcess | undefined;

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
          forceKillTimer = undefined;
          if (child !== undefined && processTreeIsAlive(child)) {
            terminateProcessTree(child, "SIGKILL");
          }
        }
        if (child !== undefined && processTreeIsAlive(child)) {
          terminateProcessTree(child, "SIGKILL");
        }
        spec.signal?.removeEventListener("abort", cancel);
        const stdout = stdoutCapture.value();
        const stderr = stderrCapture.value();
        const output = combineOutput(stdout, stderr);
        resolve({
          status,
          exitCode,
          stdout,
          stderr,
          ...(stdoutCapture.truncatedChars === 0
            ? {}
            : { stdoutTruncatedChars: stdoutCapture.truncatedChars }),
          ...(stderrCapture.truncatedChars === 0
            ? {}
            : { stderrTruncatedChars: stderrCapture.truncatedChars }),
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

      const terminate = (): void => {
        if (child === undefined) return;
        terminateProcessTree(child, "SIGTERM");
        forceKillTimer ??= setTimeout(() => {
          forceKillTimer = undefined;
          if (child !== undefined) terminateProcessTree(child, "SIGKILL");
        }, 250);
      };
      const cancel = (): void => {
        if (settled || cancelled) return;
        cancelled = true;
        terminate();
      };
      cancelSpawned = cancel;
      try {
        child = spawn(executable, [...spec.argv.slice(1)], {
          cwd: spec.cwd,
          detached: SUPPORTS_PROCESS_GROUPS,
          env: environment,
          shell: false,
          stdio: [spec.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        });
      } catch (error) {
        stderrCapture.append(errorText(error));
        finish("failed", null);
        return;
      }

      spawnedPid = child.pid;
      spec.signal?.addEventListener("abort", cancel, { once: true });

      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, spec.timeoutMs);

      if (spec.signal?.aborted) cancel();

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string | Buffer) => {
        stdoutCapture.append(chunk.toString());
        emitProgress("producing_output", {
          ...(observedModel === undefined ? {} : { model: observedModel }),
          ...(observedProvider === undefined ? {} : { provider: observedProvider }),
        });
      });
      child.stdout?.on("error", (error) => {
        stderrCapture.append(errorText(error));
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string | Buffer) => {
        stderrCapture.append(chunk.toString());
        const metadata = processMetadata(stderrCapture.prefix.slice(0, PROCESS_METADATA_CHARS));
        const changed =
          (metadata.model !== undefined && metadata.model !== observedModel) ||
          (metadata.provider !== undefined && metadata.provider !== observedProvider);
        observedModel = metadata.model ?? observedModel;
        observedProvider = metadata.provider ?? observedProvider;
        if (changed) {
          emitProgress("waiting_for_model", {
            ...(observedModel === undefined ? {} : { model: observedModel }),
            ...(observedProvider === undefined ? {} : { provider: observedProvider }),
          });
        }
      });
      child.stderr?.on("error", (error) => {
        stderrCapture.append(errorText(error));
      });
      if (spec.stdin !== undefined) {
        // A child that exits before draining stdin makes this write emit EPIPE on
        // the stdin stream. Without an "error" listener Node rethrows it as an
        // uncaught exception and takes the whole CueLine process (controller loop
        // and every concurrent job) down with it. The child has already exited, so
        // "close" still fires and finish() still reports the real exit code —
        // capturing the stream error here only prevents the process-wide crash.
        child.stdin?.on("error", (error) => {
          stderrCapture.append(errorText(error));
        });
        child.stdin?.end(spec.stdin, "utf8");
      }
      child.once("error", (error) => {
        stderrCapture.append(errorText(error));
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
