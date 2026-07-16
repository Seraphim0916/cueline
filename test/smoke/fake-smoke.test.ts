import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  continueCueLineRun,
  defaultRoutingConfigPath,
  runCueLine,
} from "../../src/api.js";
import type { BrowserTurnInput, ControllerTurn } from "../../src/browser/browser-adapter.js";
import { CueLineError } from "../../src/core/errors.js";
import type { RoutingConfig } from "../../src/router/types.js";
import { loadRoutingConfig } from "../../src/router/config-loader.js";
import { readEvents } from "../../src/state/event-log.js";
import { FakeBrowserAdapter } from "../fakes/fake-browser.js";

function reply(
  action: (input: BrowserTurnInput) => Record<string, unknown>,
): (input: BrowserTurnInput) => ControllerTurn {
  return (input) => ({
    text: `<CueLineControl>${JSON.stringify({
      protocol: "cueline/0.1",
      run_id: input.runId,
      round: input.round,
      request_id: input.requestId,
      ...action(input),
    })}</CueLineControl>`,
    conversationUrl: "https://chatgpt.com/c/cueline-smoke",
    model: {
      provider: "chatgpt",
      selectedLabel: "Pro",
      responseModelSlug: "gpt-5-6-pro",
      source: "composer_and_response",
    },
  });
}

test("the bundled process route does not inherit user MCP configuration", async () => {
  const config = await loadRoutingConfig(defaultRoutingConfigPath());
  const argv = config.lanes.default?.candidates[0]?.argv ?? [];

  assert.equal(argv.includes("--ignore-user-config"), true);
  assert.equal(argv.includes("--dangerously-bypass-approvals-and-sandbox"), false);
});

test("process execution requires the executor selection and a second explicit authorization", async () => {
  const browser = new FakeBrowserAdapter([]);
  await assert.rejects(
    runCueLine({
      executor: "process",
      request: "Must not spawn without double authorization",
      runId: "run_process_without_authorization",
      home: await mkdtemp(path.join(tmpdir(), "cueline-process-guard-")),
      browser,
      routingConfig: {
        version: 1,
        lanes: {
          default: {
            enabled: true,
            candidates: [
              {
                id: "must-not-spawn",
                argv: [process.execPath, "-e", "process.exit(99)"],
                task_input: "stdin",
              },
            ],
          },
        },
      },
    }),
    (error: unknown) =>
      error instanceof CueLineError && error.code === "PROCESS_EXECUTION_NOT_AUTHORIZED",
  );
  assert.equal(browser.calls.length, 0);
});

test("public API drives browser, routing, process execution, persistence, and final delivery", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-smoke-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "cueline-smoke-workspace-"));
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
              "process.stderr.write('model: smoke-model\\nprovider: local-test\\n'); process.stdin.setEncoding('utf8'); let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => process.stdout.write('WORKER:' + data));",
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
    executor: "process",
    allowProcessExecution: true,
    request: "Run the standalone smoke",
    runId: "run_public_smoke",
    home,
    cwd: workspace,
    browser,
    routingConfig,
    environment,
  });

  assert.equal(result.status, "complete");
  assert.equal(result.finalDeliveryText, "CUELINE_SMOKE_OK");
  const completedJob = Object.values(result.state.jobs)[0];
  assert.equal(completedJob?.spec.workdir, workspace);
  assert.equal(completedJob?.runtime?.runnerId, "node-smoke");
  assert.equal(completedJob?.runtime?.model, "smoke-model");
  assert.equal(completedJob?.runtime?.provider, "local-test");
  assert.equal(completedJob?.runtime?.phase, "completed");
  assert.equal(typeof completedJob?.runtime?.pid, "number");
  const events = await readEvents(path.join(home, "runs", result.runId, "events.jsonl"));
  assert.equal(events.some((event) => event.type === "run_completed"), true);
  const accepted = events.find((event) => event.type === "controller_command_accepted");
  const command = (accepted?.payload as { command?: { jobs?: Array<{ workdir?: string }> } })
    .command;
  assert.equal(command?.jobs?.[0]?.workdir, workspace);

  const replayed = await continueCueLineRun({
    runId: result.runId,
    home,
    routingConfigPath: path.join(home, "missing-routing.json"),
  });
  assert.equal(replayed.status, "complete");
  assert.equal(replayed.finalDeliveryText, "CUELINE_SMOKE_OK");
});

test("public process execution rejects a relative controller workdir before registration", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-relative-workdir-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "cueline-relative-workspace-"));
  const environment = { ...process.env };
  delete environment.CUELINE_DEPTH;
  let repairPrompt = "";
  const browser = new FakeBrowserAdapter([
    reply((input) => {
      assert.match(input.prompt, /workdir.*absolute path/i);
      return {
        action: "dispatch",
        jobs: [
          {
            job_key: "relative",
            lane: "smoke",
            mode: "advise",
            task: "Never run from an ambiguous relative directory",
            workdir: ".",
          },
        ],
      };
    }),
    reply((input) => {
      repairPrompt = input.prompt;
      return { action: "complete", final_delivery_text: "RELATIVE_REPAIRED" };
    }),
  ]);

  const result = await runCueLine({
    executor: "process",
    allowProcessExecution: true,
    request: "Reject ambiguous process workdirs",
    runId: "run_relative_process_workdir",
    home,
    cwd: workspace,
    browser,
    environment,
    routingConfig: {
      version: 1,
      lanes: {
        smoke: {
          enabled: true,
          candidates: [
            {
              id: "node-smoke",
              argv: [process.execPath, "-e", "process.stdin.resume()"],
              task_input: "stdin",
            },
          ],
        },
      },
    },
  });

  assert.equal(result.status, "complete");
  assert.equal(result.finalDeliveryText, "RELATIVE_REPAIRED");
  assert.match(repairPrompt, /PROCESS_WORKDIR_ABSOLUTE_REQUIRED/);
  assert.equal(Object.keys(result.state.jobs).length, 0);
  assert.equal(browser.calls[1]?.repairAttempt, 1);
});

test("process route availability is checked in the job's bound workdir", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-workdir-route-home-"));
  const runtimeWorkspace = await mkdtemp(path.join(tmpdir(), "cueline-workdir-route-runtime-"));
  const jobWorkspace = await mkdtemp(path.join(tmpdir(), "cueline-workdir-route-job-"));
  const localRunner = path.join(runtimeWorkspace, "local-runner");
  await writeFile(localRunner, "local runner fixture\n", "utf8");
  await chmod(localRunner, 0o700);
  const environment = { ...process.env };
  delete environment.CUELINE_DEPTH;
  let repairPrompt = "";
  const browser = new FakeBrowserAdapter([
    reply((input) => {
      assert.match(input.prompt, /relative-runner/);
      return {
        action: "dispatch",
        jobs: [
          {
            job_key: "different_workspace",
            lane: "smoke",
            mode: "advise",
            task: "Do not resolve a relative executable in another workspace",
            workdir: jobWorkspace,
          },
        ],
      };
    }),
    reply((input) => {
      repairPrompt = input.prompt;
      return { action: "complete", final_delivery_text: "WORKDIR_ROUTE_REPAIRED" };
    }),
  ]);

  const result = await runCueLine({
    executor: "process",
    allowProcessExecution: true,
    request: "Bind relative executable availability to the job workspace",
    runId: "run_process_workdir_route",
    home,
    cwd: runtimeWorkspace,
    browser,
    environment,
    routingConfig: {
      version: 1,
      lanes: {
        smoke: {
          enabled: true,
          candidates: [
            {
              id: "relative-runner",
              argv: ["./local-runner"],
              task_input: "stdin",
            },
          ],
        },
      },
    },
  });

  assert.equal(result.status, "complete");
  assert.equal(result.finalDeliveryText, "WORKDIR_ROUTE_REPAIRED");
  assert.match(repairPrompt, /ROUTE_NO_CANDIDATE/);
  assert.equal(Object.keys(result.state.jobs).length, 0);
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
