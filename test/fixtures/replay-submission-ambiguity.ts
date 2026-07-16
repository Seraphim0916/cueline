import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type {
  BrowserAdapter,
  BrowserTurnHooks,
  BrowserTurnInput,
  ControllerTurn,
} from "../../src/browser/browser-adapter.js";
import {
  loadCueLineRunStatus,
  submitCueLineCallerJobResult,
} from "../../src/api.js";
import {
  continueControllerLoop,
  runControllerLoop,
} from "../../src/core/controller-loop.js";
import { CueLineError } from "../../src/core/errors.js";
import { loadPersistedRunStore } from "../../src/core/persisted-run.js";
import type { ControllerJobSpec } from "../../src/protocol/types.js";
import type { RunnerSpec } from "../../src/runners/runner-adapter.js";
import { readEvents } from "../../src/state/event-log.js";
import { runPaths } from "../../src/state/paths.js";
import { FakeJobSupervisor } from "../fakes/fake-runner.js";

interface Fixture {
  schema: string;
  sourceRunId: string;
  fixtureRunId: string;
  conversationUrl: string;
  request: string;
  sourceEventTypes: string[];
}

const adjacentFixturePath = fileURLToPath(
  new URL("./submission-ambiguity-recovery.json", import.meta.url),
);
const sourceFixturePath = fileURLToPath(
  new URL(
    "../../../test/fixtures/submission-ambiguity-recovery.json",
    import.meta.url,
  ),
);
const fixture = JSON.parse(
  await readFile(adjacentFixturePath, "utf8").catch(() =>
    readFile(sourceFixturePath, "utf8"),
  ),
) as Fixture;
const mode = process.argv[2];
const home = process.env.CUELINE_HOME;

if (process.env.CUELINE_FIXTURE_REPLAY !== "1" || home === undefined) {
  throw new Error(
    "Set CUELINE_FIXTURE_REPLAY=1 and CUELINE_HOME to an isolated fixture directory.",
  );
}
if (home === process.env.HOME || home.endsWith("/.cueline")) {
  throw new Error("Refusing to use a default or real CueLine home.");
}
const isolatedHome = home;

function response(
  input: BrowserTurnInput,
  command: Record<string, unknown>,
): ControllerTurn {
  return {
    text: `<CueLineControl>${JSON.stringify({
      protocol: "cueline/0.1",
      run_id: input.runId,
      round: input.round,
      request_id: input.requestId,
      ...command,
    })}</CueLineControl>`,
    conversationUrl: fixture.conversationUrl,
    model: {
      provider: "chatgpt",
      selectedLabel: "Pro",
      responseModelSlug: "gpt-5-6-pro",
      source: "composer_and_response",
    },
  };
}

const resolver = (jobId: string, job: ControllerJobSpec): RunnerSpec => ({
  jobId,
  runnerId: "fixture-runner",
  argv: [process.execPath, "-e", "process.exit(0)", job.task],
  mode: job.mode,
  timeoutMs: job.timeout_ms ?? 1_000,
  lane: job.lane,
  task: job.task,
});

async function setup(): Promise<void> {
  const firstRoundBrowser: BrowserAdapter = {
    submissionCheckpointContract: "write_ahead_v1",
    async sendTurn(input, hooks): Promise<ControllerTurn> {
      await hooks?.onCheckpoint?.({
        submissionState: "submitting",
        composerPromptState: "inline_ready",
        conversationUrl: fixture.conversationUrl,
        selectedModelLabel: "Pro",
        baselineUserMessageCount: 0,
        baselineAssistantMessageCount: 0,
        clickAttemptState: "attempting",
      });
      await hooks?.onCheckpoint?.({
        submissionState: "submitted",
        composerPromptState: "inline_ready",
        conversationUrl: fixture.conversationUrl,
        selectedModelLabel: "Pro",
        baselineUserMessageCount: 0,
        baselineAssistantMessageCount: 0,
        clickAttemptState: "accepted",
      });
      return response(input, {
        action: "dispatch",
        jobs: [
          {
            job_key: "fixture-governance",
            lane: "default",
            mode: "advise",
            task: "Review recovery invariants.",
          },
          {
            job_key: "fixture-browser",
            lane: "default",
            mode: "advise",
            task: "Review browser submission evidence.",
          },
        ],
      });
    },
  };

  const paused = await runControllerLoop({
    runId: fixture.fixtureRunId,
    request: fixture.request,
    executor: "caller",
    allowProcessExecution: false,
    home: isolatedHome,
    browser: firstRoundBrowser,
    jobSupervisor: new FakeJobSupervisor([]),
    resolveRunnerSpec: resolver,
  });
  assert.equal(paused.status, "awaiting_caller");
  assert.equal(paused.pendingJobs?.length, 2);
  for (const [index, job] of paused.pendingJobs!.entries()) {
    await submitCueLineCallerJobResult(
      fixture.fixtureRunId,
      job.jobId,
      {
        status: "succeeded",
        stdout: `DEIDENTIFIED_CALLER_EVIDENCE_${index + 1}`,
      },
      { home: isolatedHome },
    );
  }

  const sourceShapeStore = await loadPersistedRunStore(
    isolatedHome,
    fixture.fixtureRunId,
  );
  const firstRequestPayload = (
    await readEvents(runPaths(isolatedHome, fixture.fixtureRunId).events)
  ).find((event) => event.type === "controller_turn_requested")?.payload as
    | Record<string, unknown>
    | undefined;
  const firstRequestId = firstRequestPayload?.request_id;
  assert.equal(typeof firstRequestId, "string");
  for (let index = 0; index < 3; index += 1) {
    await sourceShapeStore.append("run_resumed", {
      fixture_source_event_shape: true,
    });
  }
  await sourceShapeStore.append("controller_response_reconciled", {
    round: 1,
    request_id: firstRequestId,
    fixture_source_event_shape: true,
  });
  await sourceShapeStore.append("controller_conversation_bound", {
    request_id: firstRequestId,
    conversation_url: fixture.conversationUrl,
    fixture_source_event_shape: true,
  });

  const ambiguousBrowser: BrowserAdapter = {
    submissionCheckpointContract: "write_ahead_v1",
    async sendTurn(
      input: BrowserTurnInput,
      hooks?: BrowserTurnHooks,
    ): Promise<ControllerTurn> {
      await hooks?.onCheckpoint?.({
        submissionState: "possibly_sent",
        composerPromptState: "attachment_ready",
        conversationUrl: fixture.conversationUrl,
        selectedModelLabel: "Pro",
        baselineUserMessageCount: 1,
        baselineAssistantMessageCount: 2,
        clickAttemptState: "error",
        clickErrorName: "Error",
        clickErrorMessage: "deidentified send-button click failure",
        domEvidence: {
          pageUrl: fixture.conversationUrl,
          userMessageCount: 1,
          assistantMessageCount: 2,
          lastMessageRole: "assistant",
          lastUserMessageHash: null,
          isAnswering: false,
        },
      });
      throw new CueLineError(
        "CONTROLLER_SUBMISSION_AMBIGUOUS",
        "deidentified send-button click failure",
        {
          details: {
            stage: "submitting",
            submission_state: "possibly_sent",
            request_id: input.requestId,
          },
        },
      );
    },
  };

  await assert.rejects(
    continueControllerLoop({
      runId: fixture.fixtureRunId,
      home: isolatedHome,
      browser: ambiguousBrowser,
      jobSupervisor: new FakeJobSupervisor([]),
      resolveRunnerSpec: resolver,
    }),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "CONTROLLER_SUBMISSION_AMBIGUOUS",
  );

  const status = await loadCueLineRunStatus(fixture.fixtureRunId, {
    home: isolatedHome,
  });
  const events = await readEvents(
    runPaths(isolatedHome, fixture.fixtureRunId).events,
  );
  assert.deepEqual(
    events.map((event) => event.type).sort(),
    [...fixture.sourceEventTypes].sort(),
  );
  const pending = [...events]
    .reverse()
    .find((event) => event.type === "controller_turn_requested")?.payload as
    | Record<string, unknown>
    | undefined;
  const requestId = pending?.request_id;
  assert.equal(typeof requestId, "string");
  process.stdout.write(
    `${JSON.stringify({
      fixture: fixture.schema,
      sourceRunId: fixture.sourceRunId,
      sourceEventShapeMatched: true,
      home: isolatedHome,
      requestId,
      status,
    })}\n`,
  );
}

async function resume(): Promise<void> {
  const mockIab: BrowserAdapter = {
    submissionCheckpointContract: "write_ahead_v1",
    async submitTurn(
      input,
      hooks?: BrowserTurnHooks,
    ): Promise<void> {
      await hooks?.onCheckpoint?.({
        submissionState: "submitting",
        composerPromptState: "attachment_ready",
        conversationUrl: fixture.conversationUrl,
        selectedModelLabel: "Pro",
        baselineUserMessageCount: 1,
        baselineAssistantMessageCount: 2,
        clickAttemptState: "attempting",
      });
      await hooks?.onCheckpoint?.({
        submissionState: "submitted",
        composerPromptState: "attachment_ready",
        conversationUrl: fixture.conversationUrl,
        selectedModelLabel: "Pro",
        baselineUserMessageCount: 1,
        baselineAssistantMessageCount: 2,
        clickAttemptState: "accepted",
      });
    },
    async observeTurn(): Promise<undefined> {
      return undefined;
    },
    async sendTurn(): Promise<ControllerTurn> {
      throw new Error("detached mock IAB must use submitTurn");
    },
  };

  const result = await continueControllerLoop({
    runId: fixture.fixtureRunId,
    home: isolatedHome,
    conversationUrl: fixture.conversationUrl,
    browser: mockIab,
    jobSupervisor: new FakeJobSupervisor([]),
    resolveRunnerSpec: resolver,
    returnAfterControllerSubmission: true,
  });
  assert.equal(result.status, "awaiting_controller");
  const status = await loadCueLineRunStatus(fixture.fixtureRunId, {
    home: isolatedHome,
  });
  const events = await readEvents(
    runPaths(isolatedHome, fixture.fixtureRunId).events,
  );
  process.stdout.write(
    `${JSON.stringify({
      fixture: fixture.schema,
      sourceRunId: fixture.sourceRunId,
      home: isolatedHome,
      result,
      eventCount: events.length,
      status,
    })}\n`,
  );
}

if (mode === "setup") {
  await setup();
} else if (mode === "resume") {
  await resume();
} else {
  throw new Error("Usage: replay-submission-ambiguity setup|resume");
}
