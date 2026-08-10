#!/usr/bin/env node

/**
 * Runs a CueLine controller loop whose ChatGPT page is driven by a Claude Code
 * host over the file bridge.
 *
 *   cueline-claude-desktop-lane daemon "<request>"
 *   cueline-claude-desktop-lane status
 *
 * `daemon` is the operating mode. It must run detached from the host agent:
 * the loop blocks on browser requests that only the host can answer, so a host
 * that waits on this process synchronously would be waiting on itself.
 *
 * The host agent must be watching CUELINE_HOST_BRIDGE (default
 * ~/.cueline/host-bridge) per docs/claude-desktop-host.md, and performs caller
 * work through the cueline MCP tools.
 */
import { existsSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { createClaudeDesktopIabBrowser } from "../src/browser/claude-desktop/iab-shim.js";
import { createFileBridgeTools } from "../src/browser/claude-desktop/file-bridge.js";
import { CLAUDE_DESKTOP_IAB_TIMING_OPTIONS } from "../src/browser/claude-desktop/lane-options.js";
import { waitForCueLineLaneContinuation } from "../src/browser/claude-desktop/lane-status-guard.js";
import { createNodeFileBridgeFs } from "../src/browser/claude-desktop/node-file-bridge-fs.js";
import type { CueLineResult } from "../src/core/controller-types.js";

const bridgeRoot = process.env["CUELINE_HOST_BRIDGE"] ?? join(homedir(), ".cueline", "host-bridge");
const statusPath = join(bridgeRoot, "lane-status.json");
const logPath = join(bridgeRoot, "lane.log");

// Running from source puts this module one directory shallower than the built
// layout the packaged default assumes, so the bundled config must be named.
const sourceBundledConfig = new URL("../config/routing.default.json", import.meta.url).pathname;
const packagedBundledConfig = new URL("../../config/routing.default.json", import.meta.url).pathname;
const bundledConfig = existsSync(sourceBundledConfig)
  ? sourceBundledConfig
  : packagedBundledConfig;
if (process.env["CUELINE_CONFIG"] === undefined && existsSync(bundledConfig)) {
  process.env["CUELINE_CONFIG"] = bundledConfig;
}

const {
  continueCueLineRun,
  createCodexIabAdapter,
  loadCueLineRunStatus,
  startCueLineRun,
} = await import("../src/api.js");

const AWAITING = new Set(["awaiting_controller", "awaiting_caller", "awaiting_caller_work"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function record(entry: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  await appendFile(logPath, `${line}\n`, "utf8");
  await writeFile(statusPath, `${line}\n`, "utf8");
}

function summary(result: CueLineResult): Record<string, unknown> {
  return {
    runId: result.runId,
    status: result.status,
    ...(result.conversationUrl === undefined ? {} : { conversationUrl: result.conversationUrl }),
    ...(result.cancelledReason === undefined ? {} : { cancelledReason: result.cancelledReason }),
    pendingJobs:
      result.pendingJobs?.map((job) => ({ id: job.jobId, status: job.status })) ?? [],
  };
}

const [command, argument] = process.argv.slice(2);

if (command === "status") {
  const { readFile } = await import("node:fs/promises");
  console.log(existsSync(statusPath) ? await readFile(statusPath, "utf8") : "no run recorded yet\n");
} else if (command === "daemon") {
  if (argument === undefined || argument.trim() === "") {
    throw new Error('usage: claude-desktop-lane.ts daemon "<request>"');
  }
  // Same shape the bundled Codex skill uses: build the adapter over the host
  // browser, create the run before any send so the durable runId survives a
  // first-send failure, then advance one step at a time.
  const browser = createCodexIabAdapter({
    ...CLAUDE_DESKTOP_IAB_TIMING_OPTIONS,
    browser: createClaudeDesktopIabBrowser({
      tools: createFileBridgeTools({ root: bridgeRoot, fs: createNodeFileBridgeFs() }),
    }),
  });

  await record({ event: "starting", request: argument, bridgeRoot });
  try {
    let result = await startCueLineRun({ request: argument });
    await record({ event: "created", ...summary(result) });

    do {
      // Caller work is performed by the host agent through the cueline MCP
      // tools. Durable status is the sole continuation gate; surface status
      // alone cannot distinguish claim/start/recovery/reconciliation states.
      await waitForCueLineLaneContinuation(result.runId, {
        loadStatus: (runId) => loadCueLineRunStatus(runId),
        onBlocked: async (status) => {
          await record({
            event: "waiting",
            runId: result.runId,
            phase: status.phase,
            safeNextAction: status.safeNextAction,
          });
        },
        sleep,
      });
      result = await continueCueLineRun({ runId: result.runId, browser });
      await record({ event: "progress", ...summary(result) });
    } while (AWAITING.has(result.status));

    await record({
      event: "finished",
      ...summary(result),
      ...(result.finalDeliveryText === undefined
        ? {}
        : { finalDeliveryText: result.finalDeliveryText }),
    });
  } catch (error) {
    await record({
      event: "failed",
      code: (error as { code?: string }).code ?? null,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
} else {
  throw new Error('usage: claude-desktop-lane.ts daemon "<request>" | status');
}
