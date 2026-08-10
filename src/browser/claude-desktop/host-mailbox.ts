import { access, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CueLineError } from "../../core/errors.js";
import type {
  FileBridgeInFlightRequest,
  FileBridgeRequest,
  FileBridgeResponse,
} from "./file-bridge.js";

const REQUEST_FILE = /^(req-\d+-\d+)\.json$/;
const REQUEST_ID = /^req-\d+-\d+$/;

export interface HostMailboxWaitOptions {
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertRequestId(id: string): void {
  if (!REQUEST_ID.test(id)) {
    throw new CueLineError("HOST_MAILBOX_REQUEST_ID_INVALID", "Mailbox request id is invalid.", {
      details: { id },
    });
  }
}

function parseRequest(raw: string, expectedId: string): FileBridgeRequest {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new CueLineError("HOST_MAILBOX_REQUEST_MALFORMED", "Mailbox request is not JSON.", {
      cause: error,
      details: { id: expectedId },
    });
  }
  if (typeof value !== "object" || value === null) {
    throw new CueLineError("HOST_MAILBOX_REQUEST_MALFORMED", "Mailbox request is not an object.");
  }
  const request = value as Partial<FileBridgeRequest>;
  if (
    request.id !== expectedId ||
    typeof request.method !== "string" ||
    typeof request.params !== "object" ||
    request.params === null ||
    typeof request.createdAt !== "string"
  ) {
    throw new CueLineError(
      "HOST_MAILBOX_REQUEST_MALFORMED",
      "Mailbox request does not match the bridge contract.",
      { details: { id: expectedId } },
    );
  }
  return request as FileBridgeRequest;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const partial = `${path}.partial`;
  await writeFile(partial, JSON.stringify(value), "utf8");
  await rename(partial, path);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export async function claimNextHostMailboxRequest(
  root: string,
  now: () => number = () => Date.now(),
): Promise<FileBridgeInFlightRequest | undefined> {
  const requests = join(root, "requests");
  const inflight = join(root, "inflight");
  const responses = join(root, "responses");
  await Promise.all([
    mkdir(requests, { recursive: true }),
    mkdir(inflight, { recursive: true }),
    mkdir(responses, { recursive: true }),
  ]);

  const files = (await readdir(requests)).filter((name) => REQUEST_FILE.test(name)).sort();
  for (const file of files) {
    const match = REQUEST_FILE.exec(file);
    if (match === null) continue;
    const id = match[1]!;
    const requestPath = join(requests, file);
    const inflightPath = join(inflight, file);
    try {
      await rename(requestPath, inflightPath);
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }

    const request = parseRequest(await readFile(inflightPath, "utf8"), id);
    const claimed: FileBridgeInFlightRequest = {
      ...request,
      phase: "claimed",
      updatedAt: new Date(now()).toISOString(),
    };
    await writeJsonAtomic(inflightPath, claimed);
    const started: FileBridgeInFlightRequest = {
      ...claimed,
      // Persist before returning control to the browser tool. This preserves
      // conservative side-effect recovery even if the host dies mid-action.
      phase: "action_started",
      updatedAt: new Date(now()).toISOString(),
    };
    await writeJsonAtomic(inflightPath, started);
    return started;
  }
  return undefined;
}

export async function waitForHostMailboxRequest(
  root: string,
  options: HostMailboxWaitOptions = {},
): Promise<FileBridgeInFlightRequest> {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.waitTimeoutMs ?? 30 * 60 * 1_000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      await access(join(root, "stop.flag"));
      throw new CueLineError("HOST_MAILBOX_STOPPED", "Host mailbox stop flag is present.");
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    const request = await claimNextHostMailboxRequest(root, now);
    if (request !== undefined) return request;
    if (now() >= deadline) {
      throw new CueLineError("HOST_MAILBOX_WAIT_TIMEOUT", "Timed out waiting for bridge request.", {
        details: { timeoutMs },
      });
    }
    await sleep(pollIntervalMs);
  }
}

export async function publishHostMailboxResponse(
  root: string,
  response: FileBridgeResponse,
  now: () => number = () => Date.now(),
): Promise<void> {
  assertRequestId(response.id);
  const inflightPath = join(root, "inflight", `${response.id}.json`);
  const responsePath = join(root, "responses", `${response.id}.json`);
  const responsePartialPath = `${responsePath}.partial`;
  const request = parseRequest(await readFile(inflightPath, "utf8"), response.id);
  const completed: FileBridgeInFlightRequest = {
    ...request,
    phase: "action_completed",
    updatedAt: new Date(now()).toISOString(),
  };
  await writeJsonAtomic(inflightPath, completed);
  await writeFile(responsePartialPath, JSON.stringify(response), "utf8");
  await writeJsonAtomic(inflightPath, {
    ...completed,
    phase: "response_published",
    updatedAt: new Date(now()).toISOString(),
  } satisfies FileBridgeInFlightRequest);
  await rename(responsePartialPath, responsePath);
}
