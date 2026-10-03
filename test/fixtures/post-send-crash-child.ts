import assert from "node:assert/strict";
import { open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { continueCueLineRun, runCueLine } from "../../src/api.js";
import type {
  BrowserAdapter,
  BrowserTurnInput,
  ControllerTurn,
} from "../../src/browser/browser-adapter.js";
import { JobStatusStore, type JobStatus } from "../../src/jobs/status.js";

// This process stands in for the executor only. The files stand in for a
// separate browser that keeps its submitted turn after the executor dies.
const [mode, home, runId] = process.argv.slice(2);
assert.ok(home && runId);
assert.ok(["crash-submit", "crash-submit-multi", "crash-observe", "crash-job-status", "continue"].includes(mode!));
const startsRun = mode === "crash-submit" || mode === "crash-submit-multi";
const conversationUrl = "https://chatgpt.com/c/hermetic-post-send-crash";
const browserStatePath = path.join(home, "fake-browser-turn.json");

async function journal(method: string, input: BrowserTurnInput): Promise<void> {
  const file = await open(path.join(home!, "fake-browser-actions.jsonl"), "a", 0o600);
  try {
    await file.writeFile(`${JSON.stringify({
      method,
      pid: process.pid,
      runId: input.runId,
      round: input.round,
      requestId: input.requestId,
    })}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function notify(message: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    assert.ok(process.send, "fixture requires an IPC channel");
    process.send({ ...message, pid: process.pid }, (error: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function pauseForCrash(phase: string): Promise<never> {
  // A real referenced handle prevents Node from exiting at unresolved await.
  // The parent kills this exact child after receiving the durable barrier.
  setInterval(() => {}, 60_000);
  await notify({ type: "checkpoint", phase });
  return new Promise<never>(() => {});
}

function responseFor(input: BrowserTurnInput): ControllerTurn {
  const multiJob = mode === "crash-submit-multi";
  return {
    text: `<CueLineControl>${JSON.stringify({
      protocol: "cueline/0.1",
      run_id: input.runId,
      round: input.round,
      request_id: input.requestId,
      action: "dispatch",
      jobs: Array.from({ length: multiJob ? 3 : 1 }, (_, index) => ({
        job_key: multiJob ? `recovered_advice_${index + 1}` : "recovered_advice",
        lane: "default",
        mode: "advise",
        task: "Inspect the existing evidence without performing local work.",
      })),
    })}</CueLineControl>`,
    conversationUrl,
    model: {
      provider: "chatgpt",
      selectedLabel: "Pro",
      responseModelSlug: "gpt-5-6-pro",
      source: "composer_and_response",
    },
  };
}

async function readSubmittedResponse(input: BrowserTurnInput): Promise<ControllerTurn> {
  const submitted = JSON.parse(await readFile(browserStatePath, "utf8")) as {
    input: BrowserTurnInput;
    turn: ControllerTurn;
  };
  for (const field of ["runId", "round", "requestId", "prompt"] as const) {
    assert.equal(input[field], submitted.input[field], `recovery changed ${field}`);
  }
  assert.equal(input.durableSubmittedCheckpoint, true);
  assert.equal(input.baselineUserMessageCount, 0);
  assert.equal(input.baselineAssistantMessageCount, 0);
  await journal("observe", input);
  if (mode === "crash-observe") await pauseForCrash("response-observed");
  return submitted.turn;
}

const browser: BrowserAdapter = {
  submissionCheckpointContract: "write_ahead_v1",
  async submitTurn(input, hooks) {
    if (!startsRun) {
      await journal("unexpected-resend", input);
      throw new Error("Recovery must never submit again");
    }
    const checkpoint = {
      conversationUrl,
      selectedModelLabel: "Pro",
      composerPromptState: "inline_ready" as const,
      baselineUserMessageCount: 0,
      baselineAssistantMessageCount: 0,
    };
    await hooks?.onCheckpoint?.({ ...checkpoint, submissionState: "submitting" });
    await writeFile(browserStatePath, JSON.stringify({
      input: {
        runId: input.runId,
        round: input.round,
        requestId: input.requestId,
        prompt: input.prompt,
      },
      turn: responseFor(input),
    }));
    await journal("submit", input);
    await hooks?.onCheckpoint?.({ ...checkpoint, submissionState: "submitted" });
    await pauseForCrash("submitted");
  },
  async observeSubmittedTurn(input) {
    return { status: "response", turn: await readSubmittedResponse(input) };
  },
  async observeTurn(input) {
    await journal("unexpected-observation-path", input);
    throw new Error("Submitted recovery must retain its durable identity");
  },
  async sendTurn(input) {
    await journal("unexpected-send", input);
    throw new Error("Caller mode must use split submission");
  },
};

if (mode === "crash-job-status") {
  // Fault injection is confined to this disposable executor. Pause before
  // the second status write, after the real command path durably registered
  // that job; the first file exists and the third job is not registered yet.
  const writeStatus = JobStatusStore.prototype.write;
  JobStatusStore.prototype.write = async function(this: JobStatusStore, status: JobStatus) {
    if (status.jobKey === "recovered_advice_2" && status.status === "pending") {
      assert.equal(status.runId, runId);
      assert.equal(status.mode, "advise");
      await pauseForCrash("job-registered-before-status");
    }
    await writeStatus.call(this, status);
  };
}

try {
  const options = {
    home,
    runId,
    browser,
    routingConfig: {
      version: 1 as const,
      lanes: {
        default: {
          enabled: true,
          candidates: [{ id: "never-spawn", argv: ["never-spawn"], task_input: "stdin" as const }],
        },
      },
    },
  };
  const result = startsRun
    ? await runCueLine({ ...options, request: "Recover one submitted controller turn after executor death" })
    : await continueCueLineRun(options);
  await notify({ type: "result", status: result.status, jobIds: Object.keys(result.state.jobs) });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  process.disconnect?.();
}
