import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("public API runs in Codex's Node runtime when global process is unavailable", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-node-repl-"));
  const apiUrl = pathToFileURL(
    fileURLToPath(new URL("../../src/api.js", import.meta.url)),
  ).href;
  const runtimeUrl = pathToFileURL(
    fileURLToPath(new URL("../../src/core/runtime.js", import.meta.url)),
  ).href;
  const script = `
globalThis.nodeRepl = { cwd: ${JSON.stringify(home)}, homeDir: ${JSON.stringify(home)} };
delete globalThis.process;
const { runCueLine } = await import(${JSON.stringify(apiUrl)});
const { runtimeEnvironment } = await import(${JSON.stringify(runtimeUrl)});
const fallbackEnvironment = runtimeEnvironment();
const browser = {
  async sendTurn(input) {
    return {
      text: '<CueLineControl>' + JSON.stringify({
        protocol: 'cueline/0.1',
        run_id: input.runId,
        round: input.round,
        request_id: input.requestId,
        action: 'complete',
        final_delivery_text: 'NODE_REPL_OK'
      }) + '</CueLineControl>',
      conversationUrl: 'https://chatgpt.com/c/node-repl-test'
    };
  }
};
const result = await runCueLine({
  request: 'Node runtime compatibility',
  runId: 'run_node_repl',
  home: ${JSON.stringify(home)},
  cwd: ${JSON.stringify(home)},
  environment: { HOME: ${JSON.stringify(home)}, PATH: '' },
  routingConfig: {
    version: 1,
    lanes: {
      default: {
        enabled: true,
        candidates: [{ id: 'missing', argv: ['missing'], task_input: 'stdin' }]
      }
    }
  },
  browser
});
console.log(JSON.stringify({ status: result.status, text: result.finalDeliveryText, path: fallbackEnvironment.PATH }));
`;

  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
  });

  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(String(child.stdout).trim()), {
    status: "complete",
    text: "NODE_REPL_OK",
    path: `${path.join(home, ".local", "bin")}${path.delimiter}/opt/homebrew/bin${path.delimiter}/usr/local/bin${path.delimiter}/usr/bin${path.delimiter}/bin`,
  });
});
