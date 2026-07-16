import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCueLineRunHandoff,
  renderCueLineRunHandoffMarkdown,
} from "../../src/observation/run-handoff.js";
import {
  initialRunState,
  type CueLineRunState,
} from "../../src/core/state-machine.js";
import { summarizeCueLineRunState } from "../../src/core/run-status.js";

const secret = "SECRET-CONTENT-MUST-NOT-LEAK";

function state(): CueLineRunState {
  const initial = initialRunState(
    "run_handoff",
    `Audit the project ${secret}`,
    "caller",
    12,
    false,
  );
  return {
    ...initial,
    round: 2,
    conversationUrl: "https://chatgpt.com/c/handoff-conversation",
    pendingControllerTurns: [
      {
        round: 2,
        requestId: "msg_handoff",
        prompt: `Controller prompt ${secret}`,
        promptHash: "prompt-hash",
        repairAttempt: 0,
        submissionState: "submitted",
        conversationUrl: "https://chatgpt.com/c/handoff-conversation",
        selectedModelLabel: "Pro",
        baselineAssistantMessageCount: 1,
        composerPromptState: "inline_ready",
        manualSendConfirmed: false,
      },
    ],
    jobs: {
      job_handoff: {
        jobId: "job_handoff",
        jobKey: "edit",
        required: true,
        spec: {
          job_key: "edit",
          lane: "default",
          mode: "work",
          task: `Edit files ${secret}`,
          workdir: "/Users/vincentw/project-worktree",
        },
        status: "pending",
        output: `worker output ${secret}`,
        error: `stderr ${secret}`,
      },
    },
  };
}

test("default handoff identifies exact local state without leaking content", () => {
  const runState = state();
  const status = summarizeCueLineRunState(
    runState,
    7,
    { ownership: "missing" },
    undefined,
    { action: "dispatch", requestId: "msg_dispatch", jobKeys: ["edit"] },
  );

  const packet = buildCueLineRunHandoff(runState, status, "/tmp/cueline-home", {
    now: () => new Date("2026-07-15T01:02:03.000Z"),
  });

  assert.equal(packet.schema, "cueline-handoff/0.1");
  assert.equal(packet.run.safeNextAction, "claim_caller_work");
  assert.equal(packet.pendingControllerTurns[0]?.requestId, "msg_handoff");
  assert.equal(packet.pendingControllerTurns[0]?.selectedModelLabel, "Pro");
  assert.equal(packet.pendingControllerTurns[0]?.composerPromptState, "inline_ready");
  assert.equal(packet.jobs[0]?.workdir, "/Users/vincentw/project-worktree");
  assert.match(packet.jobs[0]?.taskHash ?? "", /^[a-f0-9]{64}$/);
  assert.match(packet.paths.runDir, /\/runs\/run_handoff$/);
  assert.equal(packet.content, undefined);
  assert.doesNotMatch(JSON.stringify(packet), new RegExp(secret));
});

test("explicit content remains bounded and never includes job output or controller prompt", () => {
  const runState = state();
  const status = summarizeCueLineRunState(runState, 7, { ownership: "missing" });

  const packet = buildCueLineRunHandoff(runState, status, "/tmp/cueline-home", {
    includeContent: true,
    maxContentChars: 24,
  });

  assert.match(packet.content?.request ?? "", /truncated/);
  assert.match(packet.content?.tasks.job_handoff ?? "", /truncated/);
  assert.ok(
    (packet.content?.request.length ?? 0) +
      Object.values(packet.content?.tasks ?? {}).reduce((sum, task) => sum + task.length, 0) <=
      24,
  );
  assert.doesNotMatch(JSON.stringify(packet), /worker output|stderr|Controller prompt/);
});

test("claim handoff targets work even when an advice job was registered first", () => {
  const runState = state();
  runState.pendingControllerTurns = [];
  runState.jobs = {
    job_advice: {
      jobId: "job_advice",
      jobKey: "advice",
      required: true,
      spec: {
        job_key: "advice",
        lane: "default",
        mode: "advise",
        task: "Inspect",
      },
      status: "pending",
      output: null,
      error: null,
    },
    ...runState.jobs,
  };
  const status = summarizeCueLineRunState(runState, 8, { ownership: "missing" });

  const packet = buildCueLineRunHandoff(runState, status, "/tmp/cueline-home");

  assert.equal(packet.run.safeNextAction, "claim_caller_work");
  assert.match(packet.next.apiExample, /"job_handoff"/);
  assert.doesNotMatch(packet.next.apiExample, /"job_advice"/);
});

test("markdown renders commands and quotes optional content as JSON strings", () => {
  const runState = state();
  const status = summarizeCueLineRunState(runState, 7, { ownership: "missing" });
  const packet = buildCueLineRunHandoff(runState, status, "/tmp/cueline-home", {
    includeContent: true,
    maxContentChars: 200,
  });

  const markdown = renderCueLineRunHandoffMarkdown(packet);

  assert.match(markdown, /cueline run status run_handoff --json/);
  assert.match(markdown, /claimCueLineCallerJob/);
  assert.match(markdown, /Request: "Audit the project/);
  assert.doesNotMatch(markdown, /worker output|stderr|Controller prompt/);
});
