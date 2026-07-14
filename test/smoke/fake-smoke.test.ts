import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { continueCueLineRun, runCueLine } from "../../src/api.js";
import type { BrowserTurnInput } from "../../src/browser/browser-adapter.js";
import { CueLineError } from "../../src/core/errors.js";
import type { RoutingConfig } from "../../src/router/types.js";
import { FakeBrowserAdapter } from "../fakes/fake-browser.js";

function reply(
  action: (input: BrowserTurnInput) => Record<string, unknown>,
): (input: BrowserTurnInput) => { text: string; conversationUrl: string } {
  return (input) => ({
    text: `<CueLineControl>${JSON.stringify({
      protocol: "cueline/0.1",
      run_id: input.runId,
      round: input.round,
      request_id: input.requestId,
      ...action(input),
    })}</CueLineControl>`,
    conversationUrl: "https://chatgpt.com/c/cueline-smoke",
  });
}

test("public API drives browser, routing, process execution, persistence, and final delivery", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-smoke-"));
  const environment = { ...process.env };
  delete environment.CUELINE_DEPTH;
  const routingConfig: RoutingConfig = {
    version: 1,
    lanes: {
      smoke: {
        enabled: true,
        candidates: [
          {
            id: "node-smoke",
            argv: [
              process.execPath,
              "-e",
              "process.stdin.setEncoding('utf8'); let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => process.stdout.write('WORKER:' + data));",
            ],
            task_input: "stdin",
          },
        ],
      },
    },
  };
  const browser = new FakeBrowserAdapter([
    reply((input) => {
      assert.match(input.prompt, /Available routing lanes: smoke \[node-smoke\]/);
      return {
        action: "dispatch",
        jobs: [
          {
            job_key: "worker",
            lane: "smoke",
            mode: "advise",
            task: "SMOKE_WORKER_OK",
            required: true,
          },
        ],
      };
    }),
    reply((input) => {
      assert.match(input.prompt, /WORKER:SMOKE_WORKER_OK/);
      return { action: "complete", final_delivery_text: "CUELINE_SMOKE_OK" };
    }),
  ]);

  const result = await runCueLine({
    request: "Run the standalone smoke",
    runId: "run_public_smoke",
    home,
    browser,
    routingConfig,
    environment,
  });

  assert.equal(result.status, "complete");
  assert.equal(result.finalDeliveryText, "CUELINE_SMOKE_OK");
  assert.match(
    await readFile(path.join(home, "runs", result.runId, "events.jsonl"), "utf8"),
    /run_completed/,
  );

  const replayed = await continueCueLineRun({
    runId: result.runId,
    home,
    routingConfigPath: path.join(home, "missing-routing.json"),
  });
  assert.equal(replayed.status, "complete");
  assert.equal(replayed.finalDeliveryText, "CUELINE_SMOKE_OK");
});

test("public API rejects a nested CueLine run before contacting the controller", async () => {
  const browser = new FakeBrowserAdapter([]);

  await assert.rejects(
    runCueLine({
      request: "Do not recurse",
      browser,
      environment: { HOME: "/tmp", PATH: "", CUELINE_DEPTH: "1" },
      routingConfig: {
        version: 1,
        lanes: {
          default: {
            enabled: true,
            candidates: [{ id: "missing", argv: ["missing", "{task}"] }],
          },
        },
      },
    }),
    (error: unknown) =>
      error instanceof CueLineError && error.code === "NESTED_ROUTING_REJECTED",
  );
  assert.equal(browser.calls.length, 0);
});
