import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";

import {
  runCueLine,
  startCueLineRun,
} from "../../src/api.js";
import type { BrowserTurnInput, ControllerTurn } from "../../src/browser/browser-adapter.js";
import {
  CUELINE_MCP_PROTOCOL_VERSION,
  serveCueLineMcp,
} from "../../src/mcp/server.js";
import type { RoutingConfig } from "../../src/router/types.js";
import { FakeBrowserAdapter } from "../fakes/fake-browser.js";

const cli = fileURLToPath(new URL("../../src/cli/main.js", import.meta.url));

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: {
    content?: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
    [key: string]: unknown;
  };
  error?: {
    code: number;
    message: string;
  };
}

const routingConfig = {
  version: 1,
  lanes: {
    default: {
      enabled: true,
      candidates: [
        {
          id: "must-not-spawn",
          argv: [process.execPath, "-e", "process.exit(99)"],
          task_input: "stdin" as const,
        },
      ],
    },
  },
} satisfies RoutingConfig;

function initialize(id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: CUELINE_MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "cueline-test-client", version: "1.0.0" },
    },
  };
}

function initialized() {
  return { jsonrpc: "2.0", method: "notifications/initialized" };
}

function toolCall(id: number, name: string, arguments_: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: arguments_ },
  };
}

async function exchange(
  messages: readonly unknown[],
  options: Parameters<typeof serveCueLineMcp>[0] = {},
): Promise<JsonRpcResponse[]> {
  const input = Readable.from(
    messages.map((message) =>
      typeof message === "string" ? `${message}\n` : `${JSON.stringify(message)}\n`,
    ),
  );
  const output = new PassThrough();
  output.setEncoding("utf8");
  let stdout = "";
  output.on("data", (chunk: string) => {
    stdout += chunk;
  });

  await serveCueLineMcp({ ...options, input, output });
  return stdout.trim() === ""
    ? []
    : stdout.trimEnd().split("\n").map((line) => JSON.parse(line) as JsonRpcResponse);
}

function responseFor(responses: readonly JsonRpcResponse[], id: number): JsonRpcResponse {
  const response = responses.find((candidate) => candidate.id === id);
  assert.ok(response, `missing JSON-RPC response for id ${id}`);
  return response;
}

function structured(response: JsonRpcResponse): Record<string, unknown> {
  assert.ok(response.result);
  assert.equal(response.result.isError, undefined);
  const value = response.result.structuredContent;
  assert.ok(value);
  assert.equal(response.result.content?.[0]?.text, JSON.stringify(value));
  return value;
}

function reply(
  command: (input: BrowserTurnInput) => Record<string, unknown>,
): (input: BrowserTurnInput) => ControllerTurn {
  return (input) => ({
    text: `<CueLineControl>${JSON.stringify({
      protocol: "cueline/0.1",
      run_id: input.runId,
      round: input.round,
      request_id: input.requestId,
      ...command(input),
    })}</CueLineControl>`,
    conversationUrl: "https://chatgpt.com/c/mcp-server-test",
    model: {
      provider: "chatgpt",
      selectedLabel: "Pro",
      responseModelSlug: "gpt-5-6-pro",
      source: "composer_and_response",
    },
  });
}

async function callerWorkFixture() {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-mcp-claim-"));
  const workdir = path.join(home, "workspace");
  await mkdir(workdir);
  const task = "Perform the exact caller work only after MCP claim and start.";
  const browser = new FakeBrowserAdapter([
    reply(() => ({
      action: "dispatch",
      jobs: [
        {
          job_key: "mcp_work",
          lane: "default",
          mode: "work",
          task,
          workdir,
        },
      ],
    })),
  ]);
  const result = await runCueLine({
    request: "Prepare one caller work job",
    runId: "run_mcp_caller_work",
    home,
    browser,
    routingConfig,
  });
  assert.equal(result.status, "awaiting_caller_work");
  const job = Object.values(result.state.jobs)[0];
  assert.ok(job);
  return { home, jobId: job.jobId, task, workdir: await realpath(workdir) };
}

test("MCP initialize and tools/list expose the fixed nine-tool contract", async () => {
  const responses = await exchange([
    initialize(),
    initialized(),
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]);

  const handshake = responseFor(responses, 1);
  assert.equal(handshake.result?.protocolVersion, CUELINE_MCP_PROTOCOL_VERSION);
  assert.deepEqual(handshake.result?.capabilities, { tools: { listChanged: false } });
  assert.equal(
    (handshake.result?.serverInfo as Record<string, unknown> | undefined)?.name,
    "cueline",
  );

  const tools = responseFor(responses, 2).result?.tools as Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "cueline_start_run",
      "cueline_continue_run",
      "cueline_run_status",
      "cueline_run_doctor",
      "cueline_claim_caller_job",
      "cueline_start_caller_job",
      "cueline_heartbeat_caller_job",
      "cueline_record_caller_job_progress",
      "cueline_list_runs",
    ],
  );
  for (const tool of tools) {
    assert.ok(tool.description.length > 0);
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.doesNotThrow(() => new Ajv2020({ strict: true }).compile(tool.inputSchema));
  }
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(byName.get("cueline_start_run")?.inputSchema.required, ["request"]);
  assert.deepEqual(byName.get("cueline_continue_run")?.inputSchema.required, ["runId"]);
  assert.deepEqual(byName.get("cueline_claim_caller_job")?.inputSchema.required, [
    "runId",
    "jobId",
    "callerId",
  ]);
  assert.deepEqual(byName.get("cueline_start_caller_job")?.inputSchema.required, [
    "runId",
    "jobId",
    "claimId",
    "callerId",
    "fencingToken",
  ]);
  assert.deepEqual(byName.get("cueline_heartbeat_caller_job")?.inputSchema.required, [
    "runId",
    "jobId",
    "claimId",
    "callerId",
    "fencingToken",
  ]);
  assert.deepEqual(byName.get("cueline_record_caller_job_progress")?.inputSchema.required, [
    "runId",
    "jobId",
    "claimId",
    "callerId",
    "fencingToken",
    "kind",
    "evidenceHash",
  ]);
  const startProperties = byName.get("cueline_start_run")?.inputSchema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  assert.equal(startProperties?.executor?.type, "string");
  assert.equal(startProperties?.allowProcessExecution?.type, "boolean");
  assert.equal(startProperties?.browserOptions?.type, "object");
});

test("start, status, doctor, and list tools return sanitized bounded evidence", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-mcp-start-"));
  const secretRequest = "private request sentinel must not leave the MCP adapter";
  const responses = await exchange([
    initialize(),
    initialized(),
    toolCall(2, "cueline_start_run", {
      request: secretRequest,
      runId: "run_mcp_start",
      home,
    }),
    toolCall(3, "cueline_run_status", { runId: "run_mcp_start", home }),
    toolCall(4, "cueline_run_doctor", { runId: "run_mcp_start", home }),
    toolCall(5, "cueline_list_runs", { home }),
  ]);

  const started = structured(responseFor(responses, 2));
  assert.equal(started.status, "ready");
  assert.equal((started.run as Record<string, unknown>).runId, "run_mcp_start");

  const status = structured(responseFor(responses, 3));
  assert.equal(status.runId, "run_mcp_start");
  assert.equal(status.safeNextAction, "continue");

  const diagnosis = structured(responseFor(responses, 4));
  assert.equal(diagnosis.runId, "run_mcp_start");
  assert.ok(Array.isArray(diagnosis.findings));

  const listed = structured(responseFor(responses, 5));
  assert.deepEqual(
    (listed.runs as Array<Record<string, unknown>>).map((entry) => entry.runId),
    ["run_mcp_start"],
  );
  assert.doesNotMatch(JSON.stringify(responses), new RegExp(secretRequest));
});

test("continue tool advances through the real API with only the browser layer faked", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-mcp-continue-"));
  await startCueLineRun({
    request: "Complete through the MCP continue adapter",
    runId: "run_mcp_continue",
    home,
  });
  const browser = new FakeBrowserAdapter([
    reply(() => ({ action: "complete", final_delivery_text: "MCP continuation complete." })),
  ]);

  const responses = await exchange(
    [
      initialize(),
      initialized(),
      toolCall(2, "cueline_continue_run", {
        runId: "run_mcp_continue",
        home,
        routingConfig,
      }),
    ],
    { browser },
  );

  const continued = structured(responseFor(responses, 2));
  assert.equal(continued.status, "complete");
  assert.equal(continued.finalDeliveryText, "MCP continuation complete.");
  assert.equal((continued.run as Record<string, unknown>).status, "complete");
  assert.equal(browser.calls.length, 1);
});

test("claim and start caller tools preserve explicit identity and fencing proof", async () => {
  const { home, jobId, task, workdir } = await callerWorkFixture();
  const callerId = "stable-mcp-client-caller";
  const claimedResponses = await exchange([
    initialize(),
    initialized(),
    toolCall(2, "cueline_claim_caller_job", {
      runId: "run_mcp_caller_work",
      jobId,
      callerId,
      home,
    }),
    toolCall(3, "cueline_claim_caller_job", {
      runId: "run_mcp_caller_work",
      jobId,
      callerId: "different-caller-on-the-same-session",
      home,
    }),
  ]);
  const claim = structured(responseFor(claimedResponses, 2));
  assert.equal(claim.callerId, callerId);
  assert.equal(claim.task, task);
  assert.equal(claim.resolvedWorkdir, workdir);
  assert.equal(claim.outcome, "claimed");
  const identityError = responseFor(claimedResponses, 3).result;
  assert.equal(identityError?.isError, true);
  assert.match(identityError?.content?.[0]?.text ?? "", /MCP_CALLER_ID_MISMATCH/);

  const startedResponses = await exchange([
    initialize(),
    initialized(),
    toolCall(2, "cueline_start_caller_job", {
      runId: "run_mcp_caller_work",
      jobId,
      claimId: claim.claimId,
      callerId,
      fencingToken: claim.fencingToken,
      home,
    }),
  ]);
  const started = structured(responseFor(startedResponses, 2));
  assert.equal(started.outcome, "started");
  assert.equal(started.claimId, claim.claimId);
  assert.equal(started.fencingToken, claim.fencingToken);

  const heartbeatResponses = await exchange([
    initialize(),
    initialized(),
    toolCall(2, "cueline_heartbeat_caller_job", {
      runId: "run_mcp_caller_work",
      jobId,
      claimId: claim.claimId,
      callerId,
      fencingToken: claim.fencingToken,
      home,
    }),
  ]);
  const heartbeat = structured(responseFor(heartbeatResponses, 2));
  assert.equal(heartbeat.outcome, "heartbeat_recorded");
  assert.equal(heartbeat.claimId, claim.claimId);
  assert.equal(heartbeat.fencingToken, claim.fencingToken);

  const progressResponses = await exchange([
    initialize(),
    initialized(),
    toolCall(2, "cueline_record_caller_job_progress", {
      runId: "run_mcp_caller_work",
      jobId,
      claimId: claim.claimId,
      callerId,
      fencingToken: claim.fencingToken,
      kind: "tool_completed",
      evidenceHash: "c".repeat(64),
      home,
    }),
  ]);
  const progress = structured(responseFor(progressResponses, 2));
  assert.equal(progress.outcome, "progress_recorded");
  assert.equal(progress.progressKind, "tool_completed");
  assert.equal(progress.progressEvidenceHash, "c".repeat(64));
});

test("a failed caller tool does not bind or poison the MCP session identity", async () => {
  const { home, jobId } = await callerWorkFixture();
  const responses = await exchange([
    initialize(),
    initialized(),
    toolCall(2, "cueline_record_caller_job_progress", {
      runId: "run_mcp_caller_work",
      jobId,
      claimId: "claim_that_does_not_exist",
      callerId: "failed-probe-caller",
      fencingToken: 1,
      kind: "tool_completed",
      evidenceHash: "d".repeat(64),
      home,
    }),
    toolCall(3, "cueline_claim_caller_job", {
      runId: "run_mcp_caller_work",
      jobId,
      callerId: "valid-caller-after-failed-probe",
      home,
    }),
  ]);

  const failedProbe = responseFor(responses, 2).result;
  assert.equal(failedProbe?.isError, true);
  assert.doesNotMatch(failedProbe?.content?.[0]?.text ?? "", /MCP_CALLER_ID_MISMATCH/);
  const claim = structured(responseFor(responses, 3));
  assert.equal(claim.callerId, "valid-caller-after-failed-probe");
  assert.equal(claim.outcome, "claimed");
});

test("process execution remains refused without per-call authorization", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-mcp-process-guard-"));
  const responses = await exchange([
    initialize(),
    initialized(),
    toolCall(2, "cueline_start_run", {
      request: "must remain unstarted",
      runId: "run_mcp_process_refused",
      home,
      executor: "process",
      allowProcessExecution: false,
    }),
  ]);

  const result = responseFor(responses, 2).result;
  assert.equal(result?.isError, true);
  assert.match(result?.content?.[0]?.text ?? "", /PROCESS_EXECUTION_NOT_AUTHORIZED/);
});

test("malformed JSON receives a JSON-RPC parse error", async () => {
  const responses = await exchange(["{not-json"]);
  assert.deepEqual(responses, [
    {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    },
  ]);
});

test("stdio server exits cleanly when the client closes stdin", async () => {
  assert.deepEqual(await exchange([]), []);
});

test("cueline mcp serve wires the real CLI stdio surface", () => {
  const input = [
    initialize(),
    initialized(),
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]
    .map((message) => JSON.stringify(message))
    .join("\n");
  const result = spawnSync(process.execPath, [cli, "mcp", "serve"], {
    input: `${input}\n`,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const responses = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
  assert.equal(responses.length, 2);
  assert.equal(responses[0].result.protocolVersion, CUELINE_MCP_PROTOCOL_VERSION);
  assert.equal(responses[1].result.tools.length, 9);
});

test("cueline mcp serve handles SIGTERM as a graceful transport shutdown", { timeout: 5_000 }, async () => {
  const child = spawn(process.execPath, [cli, "mcp", "serve"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.write(`${JSON.stringify(initialize())}\n`);
  const [chunk] = (await once(child.stdout, "data")) as [Buffer];
  assert.match(chunk.toString("utf8"), /"protocolVersion":"2025-11-25"/);

  assert.equal(child.kill("SIGTERM"), true);
  const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.equal(stderr, "");
});
