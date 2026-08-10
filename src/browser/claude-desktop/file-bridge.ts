import { CueLineError } from "../../core/errors.js";
import type {
  ClaudeAgentBrowserTools,
  ClaudeAgentReadPageOptions,
  ClaudeAgentTabInfo,
} from "./agent-tools.js";

/**
 * Filesystem the bridge talks to. Injectable so the request/response protocol
 * can be exercised without touching a disk.
 */
export interface FileBridgeFs {
  mkdir(directory: string): Promise<void>;
  /** Must publish atomically: write a temporary file, then rename it into place. */
  writeAtomic(path: string, contents: string): Promise<void>;
  /** Resolves undefined when the file does not exist yet. */
  read(path: string): Promise<string | undefined>;
  remove(path: string): Promise<void>;
}

export interface FileBridgeOptions {
  /** Directory the host agent watches. requests/inflight/responses live under it. */
  root: string;
  fs: FileBridgeFs;
  /** How long an unclaimed request waits — the host is not answering at all. */
  requestTimeoutMs?: number;
  /**
   * How long a claimed request waits. The host atomically moved it into inflight
   * and its work may legitimately block on the operator: a login, confirmation,
   * or question. Holding both to the unclaimed budget kills runs waiting for a
   * human.
   */
  claimedTimeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newRequestId?: () => string;
}

export interface FileBridgeRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
  createdAt: string;
}

export type FileBridgeInFlightPhase =
  | "claimed"
  | "action_started"
  | "action_completed"
  | "response_published";

export interface FileBridgeInFlightRequest extends FileBridgeRequest {
  phase: FileBridgeInFlightPhase;
  updatedAt: string;
}

export type FileBridgeResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code?: string; message: string } };

const DEFAULT_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_CLAIMED_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SIDE_EFFECTING_METHODS = new Set(["newTab", "navigate", "evaluate", "clickRef"]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseResponse(raw: string, id: string): FileBridgeResponse {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new CueLineError("HOST_BRIDGE_RESPONSE_MALFORMED", "Host response is not valid JSON.", {
      cause: error,
      details: { id },
    });
  }
  if (typeof decoded !== "object" || decoded === null) {
    throw new CueLineError("HOST_BRIDGE_RESPONSE_MALFORMED", "Host response is not an object.", {
      details: { id },
    });
  }
  const record = decoded as Record<string, unknown>;
  if (record["id"] !== id) {
    throw new CueLineError(
      "HOST_BRIDGE_RESPONSE_MISMATCHED",
      "Host response carries a different request id.",
      { details: { expected: id, received: record["id"] } },
    );
  }
  if (record["ok"] === true) return { id, ok: true, result: record["result"] };
  if (record["ok"] === false) {
    const error = record["error"];
    const message =
      typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : "Host reported a failure without a message.";
    const code =
      typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : undefined;
    return { id, ok: false, error: code === undefined ? { message } : { code, message } };
  }
  throw new CueLineError("HOST_BRIDGE_RESPONSE_MALFORMED", "Host response has no ok field.", {
    details: { id },
  });
}

function parseInFlightPhase(raw: string | undefined, id: string): FileBridgeInFlightPhase | undefined {
  if (raw === undefined) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<FileBridgeInFlightRequest>;
    if (value.id !== id) return undefined;
    if (
      value.phase === "claimed" ||
      value.phase === "action_started" ||
      value.phase === "action_completed" ||
      value.phase === "response_published"
    ) {
      return value.phase;
    }
  } catch {
    // Presence of inflight file still proves claim. Malformed phase is retained
    // for operator inspection and reported as claimed with phase unknown.
  }
  return undefined;
}

/**
 * Drives a Claude Code host over a request/response directory: CueLine publishes
 * one request file, the host performs exactly that browser action and publishes
 * the raw result. The host never decides what to do next, so control stays with
 * the deterministic side of the loop.
 */
export function createFileBridgeTools(options: FileBridgeOptions): ClaudeAgentBrowserTools {
  const { root, fs } = options;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const claimedTimeoutMs = options.claimedTimeoutMs ?? DEFAULT_CLAIMED_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;

  let counter = 0;
  const newRequestId =
    options.newRequestId ??
    (() => {
      counter += 1;
      return `req-${String(now())}-${String(counter)}`;
    });

  const requestPath = (id: string): string => `${root}/requests/${id}.json`;
  const inFlightPath = (id: string): string => `${root}/inflight/${id}.json`;
  const responsePath = (id: string): string => `${root}/responses/${id}.json`;

  async function call<Result>(method: string, params: Record<string, unknown>): Promise<Result> {
    const id = newRequestId();
    if (!ID_PATTERN.test(id)) {
      throw new CueLineError("HOST_BRIDGE_REQUEST_ID_INVALID", "Generated request id is unusable.", {
        details: { id },
      });
    }

    await fs.mkdir(`${root}/requests`);
    await fs.mkdir(`${root}/inflight`);
    await fs.mkdir(`${root}/responses`);

    const request: FileBridgeRequest = {
      id,
      method,
      params,
      createdAt: new Date(now()).toISOString(),
    };
    await fs.writeAtomic(requestPath(id), JSON.stringify(request));

    const publishedAt = now();
    let claimedAt: number | undefined;
    let phase: FileBridgeInFlightPhase | undefined;
    for (;;) {
      const raw = await fs.read(responsePath(id));
      if (raw !== undefined) {
        const response = parseResponse(raw, id);
        await fs.remove(responsePath(id));
        await fs.remove(requestPath(id));
        await fs.remove(inFlightPath(id));
        if (!response.ok) {
          throw new CueLineError(
            response.error.code ?? "HOST_BRIDGE_ACTION_FAILED",
            response.error.message,
            { details: { id, method } },
          );
        }
        return response.result as Result;
      }
      const rawInFlight = await fs.read(inFlightPath(id));
      if (rawInFlight !== undefined) {
        if (claimedAt === undefined) claimedAt = now();
        phase = parseInFlightPhase(rawInFlight, id) ?? phase;
      } else if (claimedAt === undefined && (await fs.read(requestPath(id))) === undefined) {
        // Legacy read+delete consumers leave no durable claim record. Treat
        // disappearance as claimed but unknown rather than assuming no action.
        claimedAt = now();
      }
      const deadline =
        claimedAt === undefined ? publishedAt + timeoutMs : claimedAt + claimedTimeoutMs;
      if (now() >= deadline) {
        // The request file stays put: an operator needs to see what the host
        // never answered, and a resumed host can still pick it up.
        const outcomeUnknown =
          claimedAt !== undefined && SIDE_EFFECTING_METHODS.has(method);
        throw new CueLineError(
          outcomeUnknown ? "HOST_BRIDGE_ACTION_OUTCOME_UNKNOWN" : "HOST_BRIDGE_TIMEOUT",
          outcomeUnknown
            ? "Host claimed a side-effecting browser action but did not publish its outcome."
            : "Host did not answer the browser request.",
          {
            details: {
              id,
              method,
              claimed: claimedAt !== undefined,
              ...(phase === undefined ? {} : { phase }),
              timeoutMs: claimedAt === undefined ? timeoutMs : claimedTimeoutMs,
            },
          },
        );
      }
      await sleep(pollIntervalMs);
    }
  }

  return {
    listTabs() {
      return call<ClaudeAgentTabInfo[]>("listTabs", {});
    },
    activeTab() {
      return call<ClaudeAgentTabInfo | undefined>("activeTab", {});
    },
    newTab(url) {
      return call<ClaudeAgentTabInfo>("newTab", url === undefined ? {} : { url });
    },
    navigate(tabId, url) {
      return call<void>("navigate", { tabId, url });
    },
    tabUrl(tabId) {
      return call<string | undefined>("tabUrl", { tabId });
    },
    tabTitle(tabId) {
      return call<string | undefined>("tabTitle", { tabId });
    },
    evaluate(tabId, source) {
      return call<unknown>("evaluate", { tabId, source });
    },
    readPage(tabId, readOptions?: ClaudeAgentReadPageOptions) {
      return call<string>("readPage", {
        tabId,
        interactiveOnly: readOptions?.interactiveOnly === true,
      });
    },
    clickRef(tabId, ref) {
      return call<void>("clickRef", { tabId, ref });
    },
  };
}
