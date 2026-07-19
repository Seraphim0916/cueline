import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { ControllerTurn } from "../../src/browser/browser-adapter.js";
import { continueCueLineRun, startCueLineRun } from "../../src/api.js";
import { CueLineError } from "../../src/core/errors.js";
import { commandHash } from "../../src/core/ids.js";
import { initialRunState, reduceRunState } from "../../src/core/state-machine.js";
import type { RunEvent } from "../../src/state/event-log.js";
import { readEvents } from "../../src/state/event-log.js";
import { runPaths } from "../../src/state/paths.js";
import { RunStore } from "../../src/state/store.js";
import { FakeBrowserAdapter } from "../fakes/fake-browser.js";

const routingConfig = {
  version: 1 as const,
  lanes: {
    default: {
      enabled: true,
      candidates: [
        {
          id: "node",
          argv: [process.execPath, "-e", "process.stdout.write('unused')"],
          task_input: "stdin" as const,
        },
      ],
    },
  },
};

async function temporaryHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "cueline-max-repair-"));
}

test("start persists the controller repair-attempt cap and continuation cannot change it", async () => {
  const home = await temporaryHome();
  const runId = "run_repair_attempts_contract";
  const created = await startCueLineRun({
    request: "Persist the repair budget before sending",
    runId,
    home,
    maxRepairAttempts: 5,
  });

  assert.equal(created.status, "ready");
  assert.equal(created.state.maxRepairAttempts, 5);
  const events = await readEvents(runPaths(home, runId).events);
  assert.equal((events[0]?.payload as Record<string, unknown>).max_repair_attempts, 5);

  // Resuming with a smaller cap than the durable one used to silently run the
  // recovered repair loop zero times and fail the run with a misleading
  // CONTROL_REPAIR_EXHAUSTED. It must now reject up front, before any browser
  // work, exactly like the durable maxRounds / maxJobEvidenceChars limits.
  const browser = new FakeBrowserAdapter([]);
  await assert.rejects(
    continueCueLineRun({
      runId,
      home,
      browser,
      maxRepairAttempts: 2,
    }),
    (error: unknown) =>
      error instanceof CueLineError && error.code === "RUN_MAX_REPAIR_ATTEMPTS_MISMATCH",
  );
  assert.equal(browser.calls.length, 0);
});

test("reduceRunState carries the repair-attempt cap from run_created and defaults when omitted", () => {
  let omitted = initialRunState("run_repair_default", "");
  omitted = reduceRunState(omitted, {
    sequence: 1,
    timestamp: "2026-07-19T00:00:01.000Z",
    type: "run_created",
    payload: { request: "no explicit repair cap", executor: "caller" },
  } satisfies RunEvent);
  assert.equal(omitted.maxRepairAttempts, 2);

  let explicit = initialRunState("run_repair_explicit", "");
  explicit = reduceRunState(explicit, {
    sequence: 1,
    timestamp: "2026-07-19T00:00:01.000Z",
    type: "run_created",
    payload: { request: "explicit repair cap", executor: "caller", max_repair_attempts: 7 },
  } satisfies RunEvent);
  assert.equal(explicit.maxRepairAttempts, 7);
});

test("resuming an in-flight repair turn uses the durable cap instead of the call default", async () => {
  const home = await temporaryHome();
  const runId = "run_repair_attempts_resume";
  const requestId = "msg_repair_attempts_resume";
  const conversationUrl = "https://chatgpt.com/c/repair-attempts-resume";
  const responseText = `<CueLineControl>${JSON.stringify({
    protocol: "cueline/0.1",
    run_id: runId,
    round: 1,
    request_id: requestId,
    action: "complete",
    final_delivery_text: "REPAIR_ATTEMPT_RESUMED",
  })}</CueLineControl>`;

  const store = await RunStore.create({
    home,
    runId,
    initialState: initialRunState(runId, "", "caller"),
    reducer: reduceRunState,
  });
  // A run created with a repair budget of 5, interrupted while a controller turn
  // had already reached repair attempt 3 (its response was received but the
  // runtime died before accepting the command).
  await store.append("run_created", {
    request: "Resume the interrupted repair turn",
    executor: "caller",
    max_repair_attempts: 5,
  });
  await store.append("controller_repair_requested", {
    round: 1,
    request_id: requestId,
    prompt: "third repair prompt",
    prompt_hash: commandHash("third repair prompt"),
    repair_attempt: 3,
  });
  await store.append("controller_turn_submitted", {
    round: 1,
    request_id: requestId,
    submission_state: "submitted",
    conversation_url: conversationUrl,
    selected_model_label: "Pro",
    composer_prompt_state: "inline_ready",
    baseline_assistant_message_count: 0,
  });
  await store.append("controller_response_received", {
    round: 1,
    request_id: requestId,
    text: responseText,
    conversation_url: conversationUrl,
    selected_model_label: "Pro",
    response_model_slug: "gpt-5-6-pro",
    model_evidence_source: "composer_and_response",
  });
  await store.append("run_failed", {
    code: "INJECTED_BEFORE_COMMAND_ACCEPTANCE",
    message: "runtime stopped before accepting the recovered repair command",
    stage: "controller_response",
  });
  await store.snapshot();
  assert.equal(store.state.pendingControllerTurns[0]?.repairAttempt, 3);

  let sendCalls = 0;
  let recoverCalls = 0;
  const browser = {
    async sendTurn(): Promise<ControllerTurn> {
      sendCalls += 1;
      throw new Error("must recover the received response instead of sending");
    },
    async recoverTurn(): Promise<ControllerTurn> {
      recoverCalls += 1;
      return {
        text: responseText,
        conversationUrl,
        model: {
          provider: "chatgpt" as const,
          selectedLabel: "Pro",
          responseModelSlug: "gpt-5-6-pro",
          source: "composer_and_response" as const,
        },
      };
    },
  };

  // maxRepairAttempts is deliberately omitted. The old code re-defaulted it to 2
  // at the reconcile site, so firstAttempt (3) > 2 skipped the loop entirely and
  // failed the run with CONTROL_REPAIR_EXHAUSTED. With the durable cap (5) it
  // recovers the already-received completed command instead.
  const result = await continueCueLineRun({
    runId,
    home,
    browser,
    conversationUrl,
    routingConfig,
  });

  assert.equal(result.status, "complete");
  assert.equal(result.finalDeliveryText, "REPAIR_ATTEMPT_RESUMED");
  assert.equal(sendCalls, 0);
  assert.equal(recoverCalls, 1);
});
