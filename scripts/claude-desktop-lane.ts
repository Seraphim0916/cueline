#!/usr/bin/env node
/** Claude Desktop file-bridge lane: status, daemon "<request>", daemon --resume <runId>. */
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import { createClaudeDesktopIabBrowser } from "../src/browser/claude-desktop/iab-shim.js";
import { createFileBridgeTools } from "../src/browser/claude-desktop/file-bridge.js";
import { acquireClaudeDesktopLaneLock } from "../src/browser/claude-desktop/lane-lock.js";
import {
  resolveClaudeDesktopBridgeRequestTimeoutMs,
  resolveClaudeDesktopIabTimingOptions,
} from "../src/browser/claude-desktop/lane-options.js";
import { runClaudeDesktopLane } from "../src/browser/claude-desktop/lane-runner.js";
import { createNodeFileBridgeFs } from "../src/browser/claude-desktop/node-file-bridge-fs.js";
import { asCueLineError } from "../src/core/errors.js";
import type { BrowserAdapter } from "../src/browser/browser-adapter.js";

const bridgeRoot = process.env["CUELINE_HOST_BRIDGE"] ?? join(homedir(), ".cueline", "host-bridge");
const statusPath = join(bridgeRoot, "lane-status.json");
const logPath = join(bridgeRoot, "lane.log");
let previousWaiting: string | undefined;
let writes = Promise.resolve();

function record(entry: Record<string, unknown>): Promise<void> {
  if (entry["event"] === "waiting") {
    const key = JSON.stringify([entry["phase"], entry["safeNextAction"]]);
    if (key === previousWaiting) return writes;
    previousWaiting = key;
  }
  writes = writes.then(async () => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n";
    await appendFile(logPath, line, "utf8");
    const partial = `${statusPath}.${process.pid}.partial`;
    await writeFile(partial, line, "utf8");
    await rename(partial, statusPath);
  });
  return writes;
}

async function mailboxFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function expirePendingRequests(): Promise<void> {
  const requests = join(bridgeRoot, "requests");
  const expired = join(bridgeRoot, "expired");
  await mkdir(expired, { recursive: true });
  let count = 0;
  for (const file of await mailboxFiles(requests)) {
    try {
      await rename(join(requests, file), join(expired, file));
      count += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await record({ event: "expired", count });
  await record({
    event: "mailbox",
    inflightCount: (await mailboxFiles(join(bridgeRoot, "inflight"))).length,
    responseCount: (await mailboxFiles(join(bridgeRoot, "responses"))).length,
  });
}

async function main(): Promise<number> {
  const [command, argument, runId, ...extra] = process.argv.slice(2);
  if (command === "status") {
    try {
      console.log(await readFile(statusPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      console.log("no run recorded yet");
    }
    return 0;
  }
  if (
    command !== "daemon" || argument === undefined || argument.trim() === "" ||
    extra.length !== 0 || (argument === "--resume" ? !runId : runId !== undefined)
  ) {
    throw new Error('usage: cueline-claude-desktop-lane status | daemon "<request>" | daemon --resume <runId>');
  }
  const lock = await acquireClaudeDesktopLaneLock(bridgeRoot);
  const daemonId = `${hostname()}-${process.pid}-${Date.now()}`;
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      try {
        await record({ event: "stopped", signal, daemonId });
      } finally {
        await lock.release();
        process.exit(2);
      }
    })().catch((error: unknown) => {
      console.error(asCueLineError(error).message);
      process.exit(1);
    });
  };
  const onTerm = (): void => stop("SIGTERM");
  const onInt = (): void => stop("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  try {
    const sourceConfig = new URL("../config/routing.default.json", import.meta.url).pathname;
    const packagedConfig = new URL("../../config/routing.default.json", import.meta.url).pathname;
    const bundledConfig = existsSync(sourceConfig) ? sourceConfig : packagedConfig;
    if (process.env["CUELINE_CONFIG"] === undefined && existsSync(bundledConfig)) {
      process.env["CUELINE_CONFIG"] = bundledConfig;
    }
    const {
      continueCueLineRun, createCodexIabAdapter, loadCueLineRunState,
      loadCueLineRunStatus, startCueLineRun,
    } = await import("../src/api.js");
    const requestTimeoutMs = resolveClaudeDesktopBridgeRequestTimeoutMs();
    const timing = resolveClaudeDesktopIabTimingOptions();
    await expirePendingRequests();
    await record({ event: "starting", daemonId, bridgeRoot, ...(argument === "--resume" ? { runId } : { request: argument }) });
    const result = await runClaudeDesktopLane({
      mode: argument === "--resume" ? { kind: "resume", runId: runId! } : { kind: "start", request: argument },
      startRun: (request) => startCueLineRun({ request }),
      continueRun: (id, browser: BrowserAdapter) => continueCueLineRun({ runId: id, browser }),
      loadStatus: (id) => loadCueLineRunStatus(id),
      persistedConversationUrl: async (id) => (await loadCueLineRunState(id)).conversationUrl ?? undefined,
      createBrowser: (conversationUrl) => createCodexIabAdapter({
        ...timing,
        ...(conversationUrl === undefined ? {} : { conversationUrl }),
        browser: createClaudeDesktopIabBrowser({
          tools: createFileBridgeTools({
            root: bridgeRoot, fs: createNodeFileBridgeFs(), daemonId, requestTimeoutMs,
          }),
        }),
      }),
      record,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    return result.outcome === "finished" ? 0 : 2;
  } catch (error) {
    const failure = asCueLineError(error);
    await record({ event: "failed", code: failure.code, message: failure.message });
    throw error;
  } finally {
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
    await lock.release();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  const failure = asCueLineError(error);
  console.error(`${failure.code}: ${failure.message}`);
  process.exitCode = 1;
}
