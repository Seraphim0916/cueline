import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  continueCueLineRun,
  startCueLineRun,
} from "../../src/api.js";
import type {
  BrowserAdapter,
  BrowserTurnHooks,
  BrowserTurnInput,
} from "../../src/browser/browser-adapter.js";
import { initialRunState, reduceRunState } from "../../src/core/state-machine.js";
import { RunStore } from "../../src/state/store.js";

class RolloverBrowser implements BrowserAdapter {
  readonly submissionCheckpointContract = "write_ahead_v1" as const;
  readonly submissions: BrowserTurnInput[] = [];
  readonly openedFrom: string[] = [];
  readonly pinned: string[] = [];
  failOpen: Error | null = null;

  async submitTurn(input: BrowserTurnInput, hooks: BrowserTurnHooks = {}) {
    this.submissions.push(structuredClone(input));
    const conversationUrl =
      this.submissions.length === 1
        ? "https://chatgpt.com/c/rollover-old"
        : "https://chatgpt.com/c/rollover-new";
    await hooks.onCheckpoint?.({
      submissionState: "submitting",
      composerPromptState: "inline_ready",
      conversationUrl,
      selectedModelLabel: "Pro",
      baselineAssistantMessageCount: 0,
    });
    await hooks.onCheckpoint?.({
      submissionState: "submitted",
      composerPromptState: "inline_ready",
      conversationUrl,
      selectedModelLabel: "Pro",
      baselineAssistantMessageCount: 0,
    });
  }

  async observeTurn() {
    return undefined;
  }

  async sendTurn(): Promise<never> {
    throw new Error("sendTurn should not run when submitTurn is available");
  }

  async openNewConversation(input: { predecessorConversationUrl: string }) {
    this.openedFrom.push(input.predecessorConversationUrl);
    if (this.failOpen) throw this.failOpen;
    return {
      predecessorConversationUrl: input.predecessorConversationUrl,
      openedUrl: "https://chatgpt.com/" as const,
    };
  }

  async pinConversation(input: { conversationUrl: string }) {
    this.pinned.push(input.conversationUrl);
    return {
      conversationUrl: input.conversationUrl,
      proof: "unpin_menuitem_observed" as const,
      result: "pinned" as const,
    };
  }
}

async function home(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "cueline-rollover-"));
}

test("malformed rollover request is rejected before run lookup", async () => {
  await assert.rejects(
    continueCueLineRun({
      runId: "run_missing_for_invalid_rollover",
      rotateControllerConversation: "context is full",
    } as unknown as Parameters<typeof continueCueLineRun>[0]),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CONTROLLER_CONVERSATION_ROTATION_EVIDENCE_INVALID",
  );
});

test("operator-confirmed context exhaustion fences predecessor and submits once in successor", async () => {
  const stateHome = await home();
  const browser = new RolloverBrowser();
  const started = await startCueLineRun({
    runId: "run_context_rollover",
    request: "Continue the same durable work after the Web conversation fills up",
    home: stateHome,
    browser,
  });
  assert.equal(started.status, "ready");

  const first = await continueCueLineRun({
    runId: started.runId,
    home: stateHome,
    browser,
  });
  assert.equal(first.status, "awaiting_controller");
  assert.equal(first.state.pendingControllerTurns.length, 1);
  const predecessorRequestId = first.state.pendingControllerTurns[0]!.requestId;

  const rotated = await continueCueLineRun({
    runId: started.runId,
    home: stateHome,
    browser,
    rotateControllerConversation: {
      trigger: "operator_confirmed_context_exhausted",
      evidence: "ChatGPT Web explicitly reported that this conversation reached its context limit.",
    },
  });

  assert.equal(rotated.status, "awaiting_controller");
  assert.equal(rotated.state.conversationGeneration, 2);
  assert.equal(rotated.state.controllerConversationRollover?.status, "active");
  assert.equal(rotated.state.conversationUrl, "https://chatgpt.com/c/rollover-new");
  assert.deepEqual(browser.openedFrom, ["https://chatgpt.com/c/rollover-old"]);
  assert.equal(browser.submissions.length, 2);
  assert.equal(rotated.state.pendingControllerTurns.length, 1);
  assert.notEqual(
    rotated.state.pendingControllerTurns[0]!.requestId,
    predecessorRequestId,
  );
  assert.equal(rotated.state.pendingControllerTurns[0]!.round, 1);
  assert.equal(rotated.state.abandonedControllerTurns.at(-1)?.requestId, predecessorRequestId);
  assert.deepEqual(
    browser.pinned,
    [
      "https://chatgpt.com/c/rollover-old",
      "https://chatgpt.com/c/rollover-new",
    ],
  );
});

test("failed replacement opening keeps predecessor pending and does not resubmit", async () => {
  const stateHome = await home();
  const browser = new RolloverBrowser();
  const started = await startCueLineRun({
    runId: "run_context_rollover_open_failure",
    request: "Keep the predecessor safe if opening a new chat fails",
    home: stateHome,
    browser,
  });
  await continueCueLineRun({ runId: started.runId, home: stateHome, browser });
  browser.failOpen = new Error("ChatGPT Pro is still answering");

  const result = await continueCueLineRun({
    runId: started.runId,
    home: stateHome,
    browser,
    rotateControllerConversation: {
      trigger: "operator_confirmed_context_exhausted",
      evidence: "Exact context exhaustion notice observed on the predecessor URL.",
    },
  });

  assert.equal(result.status, "awaiting_controller");
  assert.equal(result.state.controllerConversationRollover?.status, "failed");
  assert.equal(result.state.conversationUrl, "https://chatgpt.com/c/rollover-old");
  assert.equal(result.state.pendingControllerTurns.length, 1);
  assert.equal(browser.submissions.length, 1);
});

test("restart after successor submit activates existing URL without opening another chat", async () => {
  const stateHome = await home();
  const browser = new RolloverBrowser();
  const runId = "run_context_rollover_restart_after_submit";
  await startCueLineRun({
    runId,
    request: "Recover the already submitted successor after restart",
    home: stateHome,
    browser,
  });
  const first = await continueCueLineRun({ runId, home: stateHome, browser });
  const predecessor = first.state.pendingControllerTurns[0]!;
  const store = await RunStore.load({
    home: stateHome,
    runId,
    initialState: initialRunState(runId, ""),
    reducer: reduceRunState,
  });
  await store.append("controller_conversation_rotation_requested", {
    trigger: "operator_confirmed_context_exhausted",
    evidence: "Exact context exhaustion notice observed before restart.",
    predecessor_conversation_url: first.state.conversationUrl,
    predecessor_request_id: predecessor.requestId,
    predecessor_round: predecessor.round,
  });
  await store.append("controller_conversation_replacement_opened", {
    predecessor_conversation_url: first.state.conversationUrl,
    opened_url: "https://chatgpt.com/",
  });
  const successorRequestId = "msg_rollover_successor_after_restart";
  await store.append("controller_turn_requested", {
    round: predecessor.round,
    request_id: successorRequestId,
    prompt: predecessor.prompt,
    prompt_hash: predecessor.promptHash,
    repair_attempt: 0,
    submission_checkpoint_contract: "write_ahead_v1",
  });
  await store.append("controller_turn_submitted", {
    round: predecessor.round,
    request_id: successorRequestId,
    submission_state: "submitted",
    conversation_url: "https://chatgpt.com/c/rollover-new",
    selected_model_label: "Pro",
    baseline_assistant_message_count: 0,
    composer_prompt_state: "inline_ready",
  });
  await store.snapshot();

  const recoveredBrowser = new RolloverBrowser();
  const recovered = await continueCueLineRun({
    runId,
    home: stateHome,
    browser: recoveredBrowser,
  });

  assert.equal(recovered.status, "awaiting_controller");
  assert.equal(recovered.state.controllerConversationRollover?.status, "active");
  assert.equal(recovered.state.conversationUrl, "https://chatgpt.com/c/rollover-new");
  assert.deepEqual(recoveredBrowser.openedFrom, []);
  assert.equal(recoveredBrowser.submissions.length, 0);
  assert.equal(recovered.state.pendingControllerTurns[0]!.requestId, successorRequestId);
});
