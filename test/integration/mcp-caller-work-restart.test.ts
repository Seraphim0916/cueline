import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { loadCueLineRunState, runCueLine } from "../../src/api.js";
import type { BrowserTurnInput, ControllerTurn } from "../../src/browser/browser-adapter.js";
import { CUELINE_MCP_PROTOCOL_VERSION, serveCueLineMcp } from "../../src/mcp/server.js";
import { readAuthoritativeRunEvents } from "../../src/state/store.js";
import { FakeBrowserAdapter } from "../fakes/fake-browser.js";
import { settleWithin } from "../support/settle-within.js";

interface JsonRpcResponse {
  id: number;
  result?: {
    isError?: boolean;
    content?: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  };
}

function structured(response: JsonRpcResponse): Record<string, unknown> {
  assert.ok(response.result);
  assert.equal(response.result.isError, undefined);
  const value = response.result.structuredContent;
  assert.ok(value);
  assert.equal(response.result.content?.[0]?.text, JSON.stringify(value));
  return value;
}

function errorCode(response: JsonRpcResponse, code: string): void {
  assert.equal(response.result?.isError, true);
  const error = JSON.parse(response.result.content?.[0]?.text ?? "{}");
  assert.equal(error.error.code, code);
}

// Keep the same stdio transport open while learning the proof from tool replies.
async function session(home: string) {
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  let buffer = "";
  let nextId = 1;
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const response = JSON.parse(buffer.slice(0, end)) as JsonRpcResponse;
      buffer = buffer.slice(end + 1);
      const resolve = pending.get(response.id);
      assert.ok(resolve, `unexpected JSON-RPC response ${response.id}`);
      pending.delete(response.id);
      resolve(response);
    }
  });
  const serving = serveCueLineMcp({ input, output });
  function request(method: string, params: Record<string, unknown>) {
    const id = nextId++;
    return new Promise<JsonRpcResponse>((resolve) => {
      pending.set(id, resolve);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  await request("initialize", {
    protocolVersion: CUELINE_MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "mcp-restart-test", version: "1.0.0" },
  });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return {
    call(name: string, args: Record<string, unknown>) {
      const sessionOnly = name === "cueline_caller_work_lease_status" || name === "cueline_end_caller_work_lease";
      return request("tools/call", { name, arguments: sessionOnly ? args : { ...args, home } });
    },
    async close() {
      // EOF exercises serveCueLineMcp's finally/session.close, not a real process kill.
      input.end();
      await settleWithin(serving, 5_000, "MCP session close");
      input.destroy();
      output.destroy();
    },
  };
}

async function fixture(home: string, runId: string) {
  const workdir = path.join(home, "workspace");
  await mkdir(workdir);
  const browser = new FakeBrowserAdapter([
    (input: BrowserTurnInput): ControllerTurn => ({
      text: `<CueLineControl>${JSON.stringify({
        protocol: "cueline/0.1",
        run_id: input.runId,
        round: input.round,
        request_id: input.requestId,
        action: "dispatch",
        jobs: [{ job_key: "restart_work", lane: "default", mode: "work", task: "Recover claimed work", workdir }],
      })}</CueLineControl>`,
      conversationUrl: "https://chatgpt.com/c/mcp-restart-test",
      model: {
        provider: "chatgpt", selectedLabel: "Pro", responseModelSlug: "gpt-5-6-pro",
        source: "composer_and_response",
      },
    }),
  ]);
  const result = await runCueLine({
    home, runId, browser, request: "Prepare restart recovery work",
    routingConfig: {
      version: 1,
      lanes: { default: { enabled: true, candidates: [
        { id: "must-not-spawn", argv: [process.execPath, "-e", "process.exit(99)"], task_input: "stdin" },
      ] } },
    },
  });
  assert.equal(result.status, "awaiting_caller_work");
  const job = Object.values(result.state.jobs)[0];
  assert.ok(job);
  return job.jobId;
}

test("MCP restart recovers same-caller work only before claim expiry", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "cueline-mcp-restart-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // MCP has no injectable now option: mock Date, keeping transport and heartbeat timers real.
  let clock = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: clock });
  const home = path.join(root, "recovery");
  await mkdir(home);
  const runId = "run_mcp_restart";
  const jobId = await fixture(home, runId);
  const callerId = "stable-restart-caller";
  const claimArgs = { runId, jobId, callerId, ttlMs: 5_000 };
  const a = await session(home);
  t.after(() => a.close());
  const claim = structured(await a.call("cueline_claim_caller_job", claimArgs));
  assert.equal(claim.outcome, "claimed");
  const proof = { runId, jobId, callerId, claimId: claim.claimId, fencingToken: claim.fencingToken };
  assert.equal(structured(await a.call("cueline_start_caller_job", proof)).outcome, "started");
  const leaseArgs = { ...proof, heartbeatIntervalMs: 20, progressTimeoutMs: 10_000, maxExecutionMs: 60_000 };
  assert.equal(structured(await a.call("cueline_start_caller_work_lease", leaseArgs)).active, true);
  await a.close();
  const heartbeats = async () => (await readAuthoritativeRunEvents(home, runId))
    .filter((event) => event.type === "caller_work_heartbeat").length;
  const stoppedCount = await heartbeats();
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  assert.equal(await heartbeats(), stoppedCount, "session close must stop the old heartbeat timer");

  clock += 100;
  t.mock.timers.setTime(clock);
  const other = await session(home);
  t.after(() => other.close());
  errorCode(await other.call("cueline_claim_caller_job", { ...claimArgs, callerId: `${callerId}-round-2` }),
    "CALLER_WORK_ALREADY_CLAIMED");
  await other.close();

  const b = await session(home);
  t.after(() => b.close());
  // (a) Durable proof alone is insufficient for the new in-memory lease registry.
  for (const tool of ["cueline_caller_work_lease_status", "cueline_start_caller_work_lease"]) {
    const response = await b.call(tool, tool === "cueline_start_caller_work_lease" ? leaseArgs : proof);
    errorCode(response, "MCP_CALLER_WORK_CLAIM_NOT_IN_SESSION");
    assert.equal(JSON.parse(response.result!.content![0]!.text).error.message,
      "Call cueline_claim_caller_job in this MCP session before using its lease.");
  }
  // (b) Re-claim by the same caller retains both durable fencing values.
  const reclaimed = structured(await b.call("cueline_claim_caller_job", claimArgs));
  assert.equal(reclaimed.outcome, "already_claimed");
  assert.equal(reclaimed.claimId, claim.claimId);
  assert.equal(reclaimed.fencingToken, claim.fencingToken);
  // (c) Restart the resident lease, then observe a timer heartbeat beyond its initial renewal.
  const restarted = structured(await b.call("cueline_start_caller_work_lease", leaseArgs));
  assert.equal(restarted.outcome, "started");
  assert.equal(restarted.active, true);
  const restartedCount = await heartbeats();
  assert.ok(restartedCount > stoppedCount);
  clock += 100;
  t.mock.timers.setTime(clock);
  let renewedCount = restartedCount;
  for (let attempt = 0; attempt < 100 && renewedCount === restartedCount; attempt++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    renewedCount = await heartbeats();
  }
  assert.ok(renewedCount > restartedCount, "new session's resident timer must record another heartbeat");
  assert.equal(structured(await b.call("cueline_caller_work_lease_status", proof)).active, true);
  // (d) The unchanged proof authorizes progress and terminal result submission.
  const progress = structured(await b.call("cueline_record_caller_job_progress", {
    ...proof, kind: "verification_completed", evidenceHash: "a".repeat(64),
  }));
  assert.equal(progress.outcome, "progress_recorded");
  const submitted = structured(await b.call("cueline_submit_caller_job_result", {
    ...proof, status: "succeeded", output: "Recovered work verified", exitCode: 0,
  }));
  assert.equal(submitted.outcome, "submitted");
  assert.equal((await loadCueLineRunState(runId, { home })).jobs[jobId]?.status, "succeeded");
  assert.equal(structured(await b.call("cueline_caller_work_lease_status", proof)).active, false);
  await b.close();

  const expiredHome = path.join(root, "expired");
  await mkdir(expiredHome);
  const expiredRunId = "run_mcp_restart_expired";
  const expiredJobId = await fixture(expiredHome, expiredRunId);
  const expiredArgs = { runId: expiredRunId, jobId: expiredJobId, callerId, ttlMs: 1_000 };
  const expiredA = await session(expiredHome);
  t.after(() => expiredA.close());
  const expiredClaim = structured(await expiredA.call("cueline_claim_caller_job", expiredArgs));
  const expiredProof = { ...expiredArgs, claimId: expiredClaim.claimId, fencingToken: expiredClaim.fencingToken };
  const { ttlMs: _ttlMs, ...expiredLeaseProof } = expiredProof;
  assert.equal(structured(await expiredA.call("cueline_start_caller_job", expiredLeaseProof)).outcome, "started");
  assert.equal(structured(await expiredA.call("cueline_start_caller_work_lease", {
    ...expiredLeaseProof, heartbeatIntervalMs: 200,
  })).active, true);
  await expiredA.close();
  // Advance the test clock, not wall time; the old session can no longer renew this claim.
  clock += 1_001;
  t.mock.timers.setTime(clock);
  const expiredB = await session(expiredHome);
  t.after(() => expiredB.close());
  errorCode(await expiredB.call("cueline_claim_caller_job", expiredArgs), "CALLER_WORK_BECAME_AMBIGUOUS");
  assert.equal((await loadCueLineRunState(expiredRunId, { home: expiredHome })).jobs[expiredJobId]?.status, "ambiguous");
  const expiredEvents = await readAuthoritativeRunEvents(expiredHome, expiredRunId);
  assert.equal(expiredEvents.filter((event) => event.type === "caller_work_claimed").length, 1);
  assert.equal(expiredEvents.filter((event) => event.type === "caller_work_started").length, 1);
  assert.equal(expiredEvents.filter((event) => event.type === "caller_work_became_ambiguous").length, 1);
  errorCode(await expiredB.call("cueline_claim_caller_job", expiredArgs), "CALLER_WORK_NOT_CLAIMABLE");
  errorCode(await expiredB.call("cueline_start_caller_work_lease", expiredLeaseProof), "MCP_CALLER_WORK_CLAIM_NOT_IN_SESSION");
  await expiredB.close();
});
