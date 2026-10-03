import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCueLine, startCueLineRun } from "../../dist/src/api.js";
import { loadPersistedRunStore } from "../../dist/src/core/persisted-run.js";
import { commandHash } from "../../dist/src/core/ids.js";

// Minimal sendTurn queue from test/fakes/fake-browser.ts. Keep it here so the
// packaged validator does not depend on dist/test (not part of the package).
class FixtureBrowser {
  constructor(turns) { this.turns = [...turns]; }
  async sendTurn(input) {
    const turn = this.turns.shift();
    if (!turn) throw new Error("FAKE_BROWSER_EXHAUSTED");
    return structuredClone(turn(input));
  }
}

// The same fake browser/event infrastructure used by integration tests.
// Every durable run starts through the public API; never reads the real home.
export async function createCliContractFixture(root) {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-cli-contracts-"));
  const environment = { ...process.env, HOME: home, CUELINE_HOME: home,
    CUELINE_CONFIG: path.join(home, "routing.json") };
  delete environment.CUELINE_DEPTH;
  const routingConfig = { version: 1, lanes: { offline: { enabled: true, candidates: [{
    id: "node-contract", argv: [process.execPath, "-e",
      "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('CONTRACT_WORKER_OK'));"],
    task_input: "stdin",
  }] } } };
  const url = "https://chatgpt.com/c/cueline-cli-contract-fixture";
  function reply(command) {
    return input => ({
      text: `<CueLineControl>${JSON.stringify({
        protocol: "cueline/0.1", run_id: input.runId, round: input.round,
        request_id: input.requestId, ...command,
      })}</CueLineControl>`,
      conversationUrl: url,
      model: { provider: "chatgpt", selectedLabel: "Pro",
        responseModelSlug: "gpt-5-6-pro", source: "composer_and_response" },
    });
  }
  const job = { job_key: "contract-worker", lane: "offline", mode: "advise",
    task: "CONTRACT_WORKER_OK", required: true };
  const base = { home, cwd: root, environment, routingConfig };
  const complete = "run_contract_complete";
  const cleanup = () => rm(home, { recursive: true, force: true });
  try {
    await writeFile(environment.CUELINE_CONFIG, JSON.stringify(routingConfig));
    const result = await runCueLine({ ...base, runId: complete,
      request: "Offline CLI contract fixture", executor: "process", allowProcessExecution: true,
      browser: new FixtureBrowser([reply({ action: "dispatch", jobs: [job] }),
        reply({ action: "complete", final_delivery_text: "CONTRACT_COMPLETE" })]),
    });
    if (result.status !== "complete") throw new Error("Completed fixture did not complete");
    const waiting = "run_contract_waiting";
    const waitingResult = await runCueLine({ ...base, runId: waiting,
      request: "Offline caller job fixture",
      browser: new FixtureBrowser([reply({ action: "dispatch", jobs: [job] })]),
    });
    const jobId = Object.keys(waitingResult.state.jobs)[0];
    if (!jobId) throw new Error("Caller fixture did not register a job");
    const requestId = "msg_contract_recovery";
    const round = 1;
    const prompt = "Offline exact recovery request";
    const promptHash = commandHash(prompt);
    const evidenceHash = commandHash("offline synthetic evidence");
    async function pending(runId, failure) {
      await startCueLineRun({ ...base, runId, request: prompt });
      const store = await loadPersistedRunStore(home, runId);
      await store.append("controller_conversation_bound", { conversation_url: url });
      await store.append("controller_turn_requested", {
        round, request_id: requestId, prompt, prompt_hash: promptHash,
        submission_checkpoint_contract: "write_ahead_v1",
      });
      const checkpoint = { round, request_id: requestId, prompt_hash: promptHash,
        conversation_url: url, selected_model_label: "Pro",
        baseline_user_message_count: 0, baseline_assistant_message_count: 0,
        composer_prompt_state: "inline_ready" };
      await store.append("controller_turn_prompt_staged", checkpoint);
      await store.append("controller_turn_submission_started", { ...checkpoint, submission_state: "submitting" });
      await store.append("controller_turn_submitted", { ...checkpoint, submission_state: "submitted" });
      if (failure) await store.append(failure === "response"
        ? "controller_response_failure_observed" : "controller_delivery_timeout_observed", {
        ...checkpoint, evidence_hash: evidenceHash, evidence_source: "fresh_read_only_dom",
        retry_action_available: failure !== "response",
        failure_code: failure === "response" ? "CHATGPT_THINKING_FAILED" : "CHATGPT_MESSAGE_DELIVERY_TIMEOUT",
        observed_user_message_count: 1, assistant_message_count: 1,
      });
      await store.snapshot();
      return runId;
    }
    const manual = await pending("run_contract_manual");
    const delivery = await pending("run_contract_delivery", "delivery");
    const response = await pending("run_contract_response", "response");
    const cancel = "run_contract_cancel";
    const stop = "run_contract_stop";
    for (const runId of [cancel, stop]) await startCueLineRun({ ...base, runId, request: prompt });
    const protocolFile = path.join(home, "control.md");
    await writeFile(protocolFile, `<CueLineControl>${JSON.stringify({
      protocol: "cueline/0.1", run_id: complete, round, request_id: requestId,
      action: "complete", final_delivery_text: "CONTRACT_COMPLETE",
    })}</CueLineControl>`);
    const retryArgs = runId => [runId, "--request-id", requestId, "--round", String(round),
      "--conversation-url", url, "--evidence-hash", evidenceHash];
    const argumentsByCommand = {
      doctor: [], "self-test": [], "upgrade preflight": ["--to", "0.7.7"],
      routing: [], "routing explain": [], jobs: [], runs: [],
      "protocol lint": [protocolFile, "--run-id", complete, "--round", String(round), "--request-id", requestId],
      "runs prune": ["--older-than-days", "0"], "runs sweep": ["--stale-hours", "0"],
      "run status": [complete], "run status-at": [complete, "--sequence", "1"],
      "run diff": [complete, waiting], "run doctor": [complete],
      "run watch": [complete, "--after", "0", "--timeout-ms", "0"],
      "run handoff": [complete], "run timeline": [complete], "run graph": [complete],
      "run verify": [complete], "run audit-secrets": [complete], "run export": [complete],
      "run reconcile": [manual, "--request-id", requestId, "--manual-send-confirmed"],
      "run authorize-delivery-retry": retryArgs(delivery),
      "run authorize-response-retry": retryArgs(response),
      "run takeover": [complete], "run reconcile-runtime": [complete],
      "run cancel": [cancel], "run stop": [stop], "job cancel": [waiting, jobId],
    };
    return { environment, argumentsByCommand, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
