import { CueLineError } from "../../core/errors.js";
import type { CodexIabAdapterOptions } from "../codex-iab/chatgpt-client.js";

type ClaudeDesktopIabTimingOptions = Required<
  Pick<CodexIabAdapterOptions, "composerReadyTimeoutMs" | "browserOperationTimeoutMs">
>;

export const CLAUDE_DESKTOP_IAB_TIMING_OPTIONS: ClaudeDesktopIabTimingOptions =
  Object.freeze({
    composerReadyTimeoutMs: 120_000,
    browserOperationTimeoutMs: 180_000,
  });

const COMPOSER_READY_TIMEOUT_ENV = "CUELINE_COMPOSER_READY_TIMEOUT_MS";
const BROWSER_OPERATION_TIMEOUT_ENV = "CUELINE_BROWSER_OPERATION_TIMEOUT_MS";
const BRIDGE_REQUEST_TIMEOUT_ENV = "CUELINE_HOST_BRIDGE_REQUEST_TIMEOUT_MS";
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 3_600_000;

function resolveTimeoutMs(
  environment: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
): number {
  const rawValue = environment[name];
  if (rawValue === undefined) return defaultValue;

  const value = Number(rawValue);
  if (
    !/^[0-9]+$/.test(rawValue) ||
    !Number.isSafeInteger(value) ||
    value < MIN_TIMEOUT_MS ||
    value > MAX_TIMEOUT_MS
  ) {
    throw new CueLineError(
      "CLAUDE_DESKTOP_IAB_TIMING_OPTION_INVALID",
      `Invalid ${name}: received ${JSON.stringify(rawValue)}; expected a decimal positive integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} milliseconds.`,
    );
  }

  return value;
}

export function resolveClaudeDesktopIabTimingOptions(
  environment: NodeJS.ProcessEnv = process.env,
): ClaudeDesktopIabTimingOptions {
  const composerReadyTimeoutMs = resolveTimeoutMs(
    environment,
    COMPOSER_READY_TIMEOUT_ENV,
    CLAUDE_DESKTOP_IAB_TIMING_OPTIONS.composerReadyTimeoutMs,
  );
  const browserOperationTimeoutMs = resolveTimeoutMs(
    environment,
    BROWSER_OPERATION_TIMEOUT_ENV,
    CLAUDE_DESKTOP_IAB_TIMING_OPTIONS.browserOperationTimeoutMs,
  );

  if (
    composerReadyTimeoutMs === CLAUDE_DESKTOP_IAB_TIMING_OPTIONS.composerReadyTimeoutMs &&
    browserOperationTimeoutMs === CLAUDE_DESKTOP_IAB_TIMING_OPTIONS.browserOperationTimeoutMs &&
    environment[COMPOSER_READY_TIMEOUT_ENV] === undefined &&
    environment[BROWSER_OPERATION_TIMEOUT_ENV] === undefined
  ) {
    return CLAUDE_DESKTOP_IAB_TIMING_OPTIONS;
  }

  return Object.freeze({ composerReadyTimeoutMs, browserOperationTimeoutMs });
}

export function resolveClaudeDesktopBridgeRequestTimeoutMs(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  return resolveTimeoutMs(environment, BRIDGE_REQUEST_TIMEOUT_ENV, 120_000);
}
