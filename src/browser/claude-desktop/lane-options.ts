import type { CodexIabAdapterOptions } from "../codex-iab/chatgpt-client.js";

type ClaudeDesktopIabTimingOptions = Required<
  Pick<CodexIabAdapterOptions, "composerReadyTimeoutMs" | "browserOperationTimeoutMs">
>;

export const CLAUDE_DESKTOP_IAB_TIMING_OPTIONS: ClaudeDesktopIabTimingOptions =
  Object.freeze({
    composerReadyTimeoutMs: 120_000,
    browserOperationTimeoutMs: 180_000,
  });
