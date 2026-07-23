import { createInterface } from "node:readline";

import {
  claimCueLineCallerJob,
  continueCueLineRun,
  diagnoseCueLineRun,
  heartbeatCueLineCallerJob,
  listCueLineRuns,
  loadCueLineRunStatus,
  recordCueLineCallerJobProgress,
  startCueLineCallerJob,
  startCueLineRun,
  type CueLineResult,
  type CueLineRuntimeOptions,
} from "../api.js";
import type { BrowserAdapter } from "../browser/browser-adapter.js";
import { safeCueLineRunStatus } from "../core/run-status-view.js";
import { CueLineError } from "../core/errors.js";
import { MAX_TIMER_DELAY_MS } from "../core/timing.js";
import type { RoutingConfig } from "../router/types.js";
import { CUELINE_VERSION } from "../version.js";

export const CUELINE_MCP_PROTOCOL_VERSION = "2025-11-25" as const;

const MAX_MESSAGE_BYTES = 1024 * 1024;
const JSON_RPC_VERSION = "2.0" as const;

type JsonRpcId = string | number;
type JsonObject = Record<string, unknown>;

interface JsonSchema {
  type: "object" | "array" | "string" | "boolean" | "integer" | "number";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: readonly unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

interface JsonRpcError {
  code: number;
  message: string;
}

interface JsonRpcResponse {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: JsonRpcId | null;
  result?: JsonObject;
  error?: JsonRpcError;
}

export interface ServeCueLineMcpOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  browser?: BrowserAdapter;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

const stringProperty = (description: string): JsonSchema => ({
  type: "string",
  minLength: 1,
  description,
});

const positiveIntegerProperty = (
  description: string,
  maximum?: number,
): JsonSchema => ({
  type: "integer",
  minimum: 1,
  ...(maximum === undefined ? {} : { maximum }),
  description,
});

const runtimeProperties = {
  conversationUrl: stringProperty("Exact persisted ChatGPT conversation URL, when already known."),
  browserOptions: {
    type: "object",
    properties: {
      timeoutMs: positiveIntegerProperty("Browser turn timeout.", MAX_TIMER_DELAY_MS),
      pollIntervalMs: positiveIntegerProperty("Browser observation polling interval.", MAX_TIMER_DELAY_MS),
      stableMs: {
        type: "integer",
        minimum: 0,
        maximum: MAX_TIMER_DELAY_MS,
        description: "Required stable observation duration.",
      },
    },
    additionalProperties: false,
    description: "JSON-safe CodexIabAdapterOptions; the Browser binding remains host-injected.",
  },
  routingConfig: {
    type: "object",
    description: "Inline CueLine RoutingConfig validated by the existing API.",
  },
  routingConfigPath: stringProperty("Path to a CueLine routing configuration file."),
  home: stringProperty("CueLine durable state home."),
  cwd: stringProperty("Workspace used by the existing CueLine runtime."),
  defaultTimeoutMs: positiveIntegerProperty(
    "Default timeout for one process job.",
    MAX_TIMER_DELAY_MS,
  ),
  maxRounds: positiveIntegerProperty("Durable total controller round limit."),
  maxJobEvidenceChars: positiveIntegerProperty("Per-job controller evidence character limit."),
  maxRepairAttempts: {
    type: "integer",
    minimum: 0,
    description: "Maximum bounded controller-envelope repair attempts.",
  },
  cancellationPollIntervalMs: positiveIntegerProperty(
    "Cancellation polling interval.",
    MAX_TIMER_DELAY_MS,
  ),
  runTimeoutMs: positiveIntegerProperty(
    "Timeout for this run advancement call.",
    MAX_TIMER_DELAY_MS,
  ),
  executor: {
    type: "string",
    enum: ["caller", "process"],
    description: "Execution mode. Caller remains the default.",
  },
  allowProcessExecution: {
    type: "boolean",
    description: "Must be true in this call whenever executor is process.",
  },
  maxConcurrency: positiveIntegerProperty("Maximum process advice concurrency."),
  laneConcurrency: {
    type: "object",
    additionalProperties: positiveIntegerProperty("Per-lane concurrency limit."),
    description: "Per-lane process advice concurrency limits.",
  },
  archiveControllerConversationOnComplete: {
    type: "boolean",
    description: "Durable opt-in controller conversation archive policy.",
  },
} satisfies Record<string, JsonSchema>;

const runIdProperty = stringProperty("Exact durable CueLine run ID.");
const jobIdProperty = stringProperty("Exact durable CueLine job ID.");
const callerIdProperty: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  description: "Stable explicit identity for this MCP client's caller work.",
};

const TOOLS = [
  {
    name: "cueline_start_run",
    description:
      "Create a durable CueLine run without sending a browser turn. Process execution requires executor=process and allowProcessExecution=true in this call.",
    inputSchema: {
      type: "object",
      properties: {
        ...runtimeProperties,
        request: stringProperty("Exact user request for the controller."),
        runId: runIdProperty,
      },
      required: ["request"],
      additionalProperties: false,
    },
  },
  {
    name: "cueline_continue_run",
    description:
      "Advance the same durable CueLine run through the existing API. Process runs require allowProcessExecution=true again in every continuation call.",
    inputSchema: {
      type: "object",
      properties: {
        ...runtimeProperties,
        runId: runIdProperty,
        reconcileRequestId: stringProperty("Exact pending controller request ID to reconcile."),
        abandonOtherPendingTurns: {
          type: "boolean",
          description: "Explicitly abandon other legacy pending turns during exact reconciliation.",
        },
        manualSendConfirmed: {
          type: "boolean",
          description: "Confirm the exact manually submitted controller turn.",
        },
      },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "cueline_run_status",
    description:
      "Return the metadata-only run status allowlist; never returns prompts, task bodies, caller identities, workdirs, or worker output.",
    inputSchema: {
      type: "object",
      properties: { runId: runIdProperty, home: runtimeProperties.home },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "cueline_run_doctor",
    description:
      "Diagnose one durable run with stable finding codes, bounded evidence, and one safe next action.",
    inputSchema: {
      type: "object",
      properties: { runId: runIdProperty, home: runtimeProperties.home },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "cueline_claim_caller_job",
    description:
      "Atomically claim one caller work job. Reuse the same explicit callerId for this MCP client; initialize clientInfo is descriptive, not identity proof.",
    inputSchema: {
      type: "object",
      properties: {
        runId: runIdProperty,
        jobId: jobIdProperty,
        callerId: callerIdProperty,
        ttlMs: {
          type: "integer",
          minimum: 1_000,
          maximum: 86_400_000,
          description: "Caller work claim lifetime.",
        },
        home: runtimeProperties.home,
      },
      required: ["runId", "jobId", "callerId"],
      additionalProperties: false,
    },
  },
  {
    name: "cueline_start_caller_job",
    description:
      "Durably start exactly one claimed caller work job with the claim ID, caller ID, and fencing token returned by claim.",
    inputSchema: {
      type: "object",
      properties: {
        runId: runIdProperty,
        jobId: jobIdProperty,
        claimId: stringProperty("Exact claim ID returned by cueline_claim_caller_job."),
        callerId: callerIdProperty,
        fencingToken: positiveIntegerProperty("Exact fencing token returned by the claim."),
        home: runtimeProperties.home,
      },
      required: ["runId", "jobId", "claimId", "callerId", "fencingToken"],
      additionalProperties: false,
    },
  },
  {
    name: "cueline_heartbeat_caller_job",
    description:
      "Renew exactly one active caller work claim with the claim ID, caller ID, and fencing token returned by claim. The executor client owns heartbeat scheduling.",
    inputSchema: {
      type: "object",
      properties: {
        runId: runIdProperty,
        jobId: jobIdProperty,
        claimId: stringProperty("Exact claim ID returned by cueline_claim_caller_job."),
        callerId: callerIdProperty,
        fencingToken: positiveIntegerProperty("Exact fencing token returned by the claim."),
        home: runtimeProperties.home,
      },
      required: ["runId", "jobId", "claimId", "callerId", "fencingToken"],
      additionalProperties: false,
    },
  },
  {
    name: "cueline_record_caller_job_progress",
    description:
      "Record one new executor-observed caller-work progress checkpoint. Heartbeats alone are not progress; repeated evidence hashes do not extend the review deadline.",
    inputSchema: {
      type: "object",
      properties: {
        runId: runIdProperty,
        jobId: jobIdProperty,
        claimId: stringProperty("Exact claim ID returned by cueline_claim_caller_job."),
        callerId: callerIdProperty,
        fencingToken: positiveIntegerProperty("Exact fencing token returned by the claim."),
        kind: {
          type: "string",
          enum: ["tool_completed", "checkpoint_persisted", "verification_completed"],
          description: "Executor-observed completion category.",
        },
        evidenceHash: {
          type: "string",
          minLength: 64,
          maxLength: 64,
          pattern: "^[0-9a-f]{64}$",
          description: "Lowercase SHA-256 of bounded progress evidence; raw output is not stored.",
        },
        home: runtimeProperties.home,
      },
      required: [
        "runId",
        "jobId",
        "claimId",
        "callerId",
        "fencingToken",
        "kind",
        "evidenceHash",
      ],
      additionalProperties: false,
    },
  },
  {
    name: "cueline_list_runs",
    description:
      "List sanitized persisted run summaries without controller text, conversation URLs, job tasks, or worker output.",
    inputSchema: {
      type: "object",
      properties: { home: runtimeProperties.home },
      additionalProperties: false,
    },
  },
] as const satisfies readonly McpToolDefinition[];

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestId(value: unknown): JsonRpcId | null {
  if (typeof value === "string") return value;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function errorResponse(id: JsonRpcId | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: JSON_RPC_VERSION, id, error: { code, message } };
}

function resultResponse(id: JsonRpcId, result: JsonObject): JsonRpcResponse {
  return { jsonrpc: JSON_RPC_VERSION, id, result };
}

function validateSchema(value: unknown, schema: JsonSchema, path = "arguments"): string[] {
  if (schema.enum !== undefined && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    return [`${path} must be one of ${schema.enum.map(String).join(", ")}`];
  }
  if (schema.type === "object") {
    if (!isObject(value)) return [`${path} must be an object`];
    const errors: string[] = [];
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) errors.push(`${path}.${required} is required`);
    }
    for (const [key, item] of Object.entries(value)) {
      const property = schema.properties?.[key];
      if (property !== undefined) {
        errors.push(...validateSchema(item, property, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key} is not allowed`);
      } else if (isObject(schema.additionalProperties)) {
        errors.push(
          ...validateSchema(item, schema.additionalProperties as JsonSchema, `${path}.${key}`),
        );
      }
    }
    return errors;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return [`${path} must be an array`];
    return schema.items === undefined
      ? []
      : value.flatMap((item, index) => validateSchema(item, schema.items!, `${path}[${index}]`));
  }
  if (schema.type === "string") {
    if (typeof value !== "string") return [`${path} must be a string`];
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return [`${path} must contain at least ${schema.minLength} character(s)`];
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      return [`${path} must contain at most ${schema.maxLength} character(s)`];
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      return [`${path} must match ${schema.pattern}`];
    }
    return [];
  }
  if (schema.type === "boolean") {
    return typeof value === "boolean" ? [] : [`${path} must be a boolean`];
  }
  if (schema.type === "integer" || schema.type === "number") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (schema.type === "integer" && !Number.isSafeInteger(value))
    ) {
      return [`${path} must be a finite ${schema.type}`];
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      return [`${path} must be at least ${schema.minimum}`];
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return [`${path} must be at most ${schema.maximum}`];
    }
  }
  return [];
}

function runtimeOptions(
  args: JsonObject,
  options: ServeCueLineMcpOptions,
): CueLineRuntimeOptions {
  const exposedKeys = Object.keys(runtimeProperties);
  const values: Record<string, unknown> = {};
  for (const key of exposedKeys) {
    if (Object.hasOwn(args, key)) values[key] = args[key];
  }
  if (Object.hasOwn(values, "routingConfig")) {
    values.routingConfig = values.routingConfig as RoutingConfig;
  }
  if (options.browser !== undefined) values.browser = options.browser;
  if (options.environment !== undefined) values.environment = options.environment;
  if (options.signal !== undefined) values.signal = options.signal;
  return values as CueLineRuntimeOptions;
}

async function boundedRunResult(
  result: CueLineResult,
  runtime: CueLineRuntimeOptions,
): Promise<JsonObject> {
  const run = safeCueLineRunStatus(await loadCueLineRunStatus(result.runId, runtime));
  return {
    runId: result.runId,
    status: result.status,
    ...(result.finalDeliveryText === undefined
      ? {}
      : { finalDeliveryText: result.finalDeliveryText }),
    ...(result.cancelledReason === undefined ? {} : { cancelledReason: result.cancelledReason }),
    run,
  };
}

async function executeTool(
  name: string,
  args: JsonObject,
  options: ServeCueLineMcpOptions,
): Promise<JsonObject> {
  const runtime = runtimeOptions(args, options);
  switch (name) {
    case "cueline_start_run": {
      const result = await startCueLineRun({
        ...runtime,
        request: args.request as string,
        ...(args.runId === undefined ? {} : { runId: args.runId as string }),
      });
      return boundedRunResult(result, runtime);
    }
    case "cueline_continue_run": {
      const result = await continueCueLineRun({
        ...runtime,
        runId: args.runId as string,
        ...(args.reconcileRequestId === undefined
          ? {}
          : { reconcileRequestId: args.reconcileRequestId as string }),
        ...(args.abandonOtherPendingTurns === undefined
          ? {}
          : { abandonOtherPendingTurns: args.abandonOtherPendingTurns as boolean }),
        ...(args.manualSendConfirmed === undefined
          ? {}
          : { manualSendConfirmed: args.manualSendConfirmed as boolean }),
      });
      return boundedRunResult(result, runtime);
    }
    case "cueline_run_status":
      return safeCueLineRunStatus(
        await loadCueLineRunStatus(args.runId as string, runtime),
      );
    case "cueline_run_doctor":
      return { ...(await diagnoseCueLineRun(args.runId as string, runtime)) };
    case "cueline_claim_caller_job":
      // MCP clientInfo is unauthenticated metadata. The explicit callerId remains
      // the durable identity and must be reused in every fenced proof.
      return {
        ...(await claimCueLineCallerJob(args.runId as string, args.jobId as string, {
          ...runtime,
          callerId: args.callerId as string,
          ...(args.ttlMs === undefined ? {} : { ttlMs: args.ttlMs as number }),
        })),
      };
    case "cueline_start_caller_job":
      return {
        ...(await startCueLineCallerJob(
          args.runId as string,
          args.jobId as string,
          {
            claimId: args.claimId as string,
            callerId: args.callerId as string,
            fencingToken: args.fencingToken as number,
          },
          runtime,
        )),
      };
    case "cueline_heartbeat_caller_job":
      return {
        ...(await heartbeatCueLineCallerJob(
          args.runId as string,
          args.jobId as string,
          {
            claimId: args.claimId as string,
            callerId: args.callerId as string,
            fencingToken: args.fencingToken as number,
          },
          runtime,
        )),
      };
    case "cueline_record_caller_job_progress":
      return {
        ...(await recordCueLineCallerJobProgress(
          args.runId as string,
          args.jobId as string,
          {
            claimId: args.claimId as string,
            callerId: args.callerId as string,
            fencingToken: args.fencingToken as number,
          },
          {
            kind: args.kind as
              | "tool_completed"
              | "checkpoint_persisted"
              | "verification_completed",
            evidenceHash: args.evidenceHash as string,
          },
          runtime,
        )),
      };
    case "cueline_list_runs":
      return { runs: await listCueLineRuns(runtime) };
    default:
      throw new CueLineError("MCP_TOOL_NOT_FOUND", `Unknown tool: ${name}`);
  }
}

function toolResult(value: JsonObject, isError = false): JsonObject {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function toolError(error: unknown): JsonObject {
  const value =
    error instanceof CueLineError
      ? { error: { code: error.code, message: error.message } }
      : {
          error: {
            code: "MCP_TOOL_EXECUTION_FAILED",
            message: "CueLine tool execution failed.",
          },
        };
  return toolResult(value, true);
}

class CueLineMcpSession {
  #initializeAnswered = false;
  #initialized = false;
  #callerId: string | undefined;

  constructor(private readonly options: ServeCueLineMcpOptions) {}

  #assertCallerIdCompatible(toolName: string, args: JsonObject): void {
    if (
      toolName !== "cueline_claim_caller_job" &&
      toolName !== "cueline_start_caller_job" &&
      toolName !== "cueline_heartbeat_caller_job" &&
      toolName !== "cueline_record_caller_job_progress"
    ) return;
    const callerId = args.callerId as string;
    if (this.#callerId !== undefined && this.#callerId !== callerId) {
      throw new CueLineError(
        "MCP_CALLER_ID_MISMATCH",
        "This MCP client session is already bound to a different callerId.",
      );
    }
  }

  #bindCallerIdAfterSuccess(toolName: string, args: JsonObject): void {
    if (
      this.#callerId !== undefined ||
      (toolName !== "cueline_claim_caller_job" &&
        toolName !== "cueline_start_caller_job" &&
        toolName !== "cueline_heartbeat_caller_job" &&
        toolName !== "cueline_record_caller_job_progress")
    ) return;
    // clientInfo is descriptive, so the first successful caller operation
    // binds this stdio session without letting a failed probe poison it.
    this.#callerId = args.callerId as string;
  }

  async handle(value: unknown): Promise<JsonRpcResponse | undefined> {
    if (!isObject(value)) return errorResponse(null, -32600, "Invalid Request");
    const id = requestId(value.id);
    if (value.jsonrpc !== JSON_RPC_VERSION || typeof value.method !== "string") {
      return errorResponse(id, -32600, "Invalid Request");
    }
    const hasId = Object.hasOwn(value, "id");
    if (hasId && id === null) return errorResponse(null, -32600, "Invalid Request");
    if (!hasId) {
      if (value.method === "notifications/initialized" && this.#initializeAnswered) {
        this.#initialized = true;
      }
      return undefined;
    }

    if (value.method === "ping") return resultResponse(id!, {});
    if (value.method === "initialize") {
      if (this.#initializeAnswered) {
        return errorResponse(id!, -32600, "Server is already initialized");
      }
      if (!isObject(value.params)) {
        return errorResponse(id!, -32602, "Invalid initialize parameters");
      }
      const clientInfo = value.params.clientInfo;
      if (
        typeof value.params.protocolVersion !== "string" ||
        !isObject(value.params.capabilities) ||
        !isObject(clientInfo) ||
        typeof clientInfo.name !== "string" ||
        typeof clientInfo.version !== "string"
      ) {
        return errorResponse(id!, -32602, "Invalid initialize parameters");
      }
      this.#initializeAnswered = true;
      return resultResponse(id!, {
        protocolVersion: CUELINE_MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: "cueline",
          version: CUELINE_VERSION,
          description: "CueLine bounded durable-run tools over stdio.",
        },
        instructions:
          "Caller work requires an explicit stable callerId plus the exact returned claim ID and fencing token. Process execution is never enabled by default.",
      });
    }
    if (!this.#initializeAnswered || !this.#initialized) {
      return errorResponse(id!, -32002, "Server not initialized");
    }
    if (value.method === "tools/list") {
      if (value.params !== undefined && !isObject(value.params)) {
        return errorResponse(id!, -32602, "Invalid tools/list parameters");
      }
      if (isObject(value.params) && value.params.cursor !== undefined) {
        return errorResponse(id!, -32602, "Invalid tools/list cursor");
      }
      return resultResponse(id!, { tools: TOOLS });
    }
    if (value.method === "tools/call") {
      const params = value.params;
      if (
        !isObject(params) ||
        typeof params.name !== "string" ||
        (params.arguments !== undefined && !isObject(params.arguments))
      ) {
        return errorResponse(id!, -32602, "Invalid tools/call parameters");
      }
      const tool = TOOLS.find((candidate) => candidate.name === params.name);
      if (tool === undefined) {
        return errorResponse(id!, -32602, `Unknown tool: ${params.name}`);
      }
      const args = (params.arguments ?? {}) as JsonObject;
      const validationErrors = validateSchema(args, tool.inputSchema);
      if (validationErrors.length > 0) {
        return resultResponse(
          id!,
          toolError(
            new CueLineError("MCP_TOOL_INPUT_INVALID", validationErrors.join("; ")),
          ),
        );
      }
      try {
        this.#assertCallerIdCompatible(tool.name, args);
        const result = await executeTool(tool.name, args, this.options);
        this.#bindCallerIdAfterSuccess(tool.name, args);
        return resultResponse(id!, toolResult(result));
      } catch (error) {
        return resultResponse(id!, toolError(error));
      }
    }
    return errorResponse(id!, -32601, "Method not found");
  }
}

async function writeResponse(
  output: NodeJS.WritableStream,
  response: JsonRpcResponse,
): Promise<void> {
  const line = `${JSON.stringify(response)}\n`;
  await new Promise<void>((resolve, reject) => {
    output.write(line, (error?: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function serveCueLineMcp(options: ServeCueLineMcpOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
  const session = new CueLineMcpSession(options);
  const abort = () => lines.close();
  if (options.signal?.aborted) return;
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    for await (const line of lines) {
      let response: JsonRpcResponse | undefined;
      if (Buffer.byteLength(line, "utf8") > MAX_MESSAGE_BYTES) {
        response = errorResponse(null, -32600, "Invalid Request");
      } else {
        try {
          response = await session.handle(JSON.parse(line));
        } catch (error) {
          if (error instanceof SyntaxError) response = errorResponse(null, -32700, "Parse error");
          else throw error;
        }
      }
      if (response !== undefined) await writeResponse(output, response);
    }
  } finally {
    options.signal?.removeEventListener("abort", abort);
    lines.close();
  }
}
