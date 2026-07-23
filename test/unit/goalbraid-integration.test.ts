import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CueLineError } from "../../src/core/errors.js";
import {
  GOALBRAID_DECISION_REQUEST_SCHEMA,
  GOALBRAID_DECISION_RESPONSE_SCHEMA,
  assertGoalbraidDecisionRunBinding,
  buildGoalbraidDecisionPrompt,
  loadGoalbraidDecisionRequest,
  parseGoalbraidDecisionDelivery,
  publishGoalbraidDecisionResponse,
  type GoalbraidDecisionRequest,
} from "../../src/integrations/goalbraid.js";

const PYTHON_COMPATIBLE_DIGEST =
  "sha256:a5d7e51a050e63fdb3e6cf3dee07071c4a6c9044d566006d483ec6c61956a38e";

function fixtureRequest(): GoalbraidDecisionRequest {
  return {
    schema: GOALBRAID_DECISION_REQUEST_SCHEMA,
    request_id: "gbd-a5d7e51a050e63fdb3e6cf3dee07071c",
    request_digest: PYTHON_COMPATIBLE_DIGEST,
    campaign_id: "fixture-專案",
    created_at: "2026-07-22T00:00:00+00:00",
    authority: {
      decision_controller: "cueline",
      executor: "omnilane",
      completion_authority: "goalbraid",
      advisory_only: true,
    },
    snapshot: {
      schema: "goalbraid-turning-point/v1",
      runnable_children: [
        { goal_id: "目標-a", run_id: "run-a", priority: 2, depends_on: [] },
        { goal_id: "goal-b", run_id: "run-b", priority: 1, depends_on: [] },
      ],
      rollup_satisfied: false,
      gate: { value_gate_enabled: true, serial_single_holder: true },
    },
    response_schema: GOALBRAID_DECISION_RESPONSE_SCHEMA,
  };
}

async function fixturePath(): Promise<{ root: string; requestPath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "cueline-goalbraid-"));
  const request = fixtureRequest();
  const requestDirectory = path.join(root, "requests");
  await mkdir(requestDirectory, { recursive: true });
  const requestPath = path.join(requestDirectory, `${request.request_id}.json`);
  await writeFile(requestPath, `${JSON.stringify(request)}\n`, "utf8");
  return { root, requestPath };
}

function fixturePublicationResult(
  request: GoalbraidDecisionRequest,
  overrides: {
    runId?: string;
    stateRunId?: string;
    stateRequest?: string;
    executor?: "caller" | "process";
    allowProcessExecution?: boolean;
    finalDeliveryText?: string;
  } = {},
): Parameters<typeof publishGoalbraidDecisionResponse>[1] {
  const runId = overrides.runId ?? "cl-goalbraid-fixture";
  return {
    runId,
    status: "complete",
    finalDeliveryText:
      overrides.finalDeliveryText ?? '{"decision":"select:goal-b"}',
    state: {
      runId: overrides.stateRunId ?? runId,
      request: overrides.stateRequest ?? buildGoalbraidDecisionPrompt(request),
      executor: overrides.executor ?? "caller",
      allowProcessExecution: overrides.allowProcessExecution ?? false,
    },
  } as Parameters<typeof publishGoalbraidDecisionResponse>[1];
}

test("loads a Python-compatible Goalbraid request and preserves the authority boundary", async () => {
  const { requestPath } = await fixturePath();
  const request = await loadGoalbraidDecisionRequest(requestPath);

  assert.equal(request.request_digest, PYTHON_COMPATIBLE_DIGEST);
  assert.equal(request.authority.decision_controller, "cueline");
  assert.equal(request.authority.executor, "omnilane");
  assert.equal(request.authority.completion_authority, "goalbraid");

  const prompt = buildGoalbraidDecisionPrompt(request);
  assert.match(prompt, /advisory only/);
  assert.match(prompt, /Do not dispatch/);
  assert.match(prompt, /select:目標-a/);
  assert.match(prompt, /Goalbraid is the sole completion authority/);
});

test("accepts only one decision from the closed runnable set", () => {
  const request = fixtureRequest();
  assert.deepEqual(parseGoalbraidDecisionDelivery('{"decision":"select:goal-b"}', request), {
    decision: "select:goal-b",
  });
  assert.throws(
    () => parseGoalbraidDecisionDelivery('{"decision":"select:ghost"}', request),
    (error: unknown) =>
      error instanceof CueLineError && error.code === "GOALBRAID_DECISION_OUTSIDE_CLOSED_SET",
  );
  assert.throws(
    () =>
      parseGoalbraidDecisionDelivery(
        '{"decision":"select:goal-b","completion_authority":"cueline"}',
        request,
      ),
    (error: unknown) =>
      error instanceof CueLineError && error.code === "GOALBRAID_DECISION_DELIVERY_INVALID",
  );
});

test("binds publication to the exact advice-only CueLine run", () => {
  const request = fixtureRequest();
  const boundResult = {
    runId: "cl-goalbraid-fixture",
    state: {
      runId: "cl-goalbraid-fixture",
      request: buildGoalbraidDecisionPrompt(request),
      executor: "caller",
      allowProcessExecution: false,
    },
  } as Parameters<typeof assertGoalbraidDecisionRunBinding>[1];

  assert.doesNotThrow(() => assertGoalbraidDecisionRunBinding(request, boundResult));
  assert.throws(
    () =>
      assertGoalbraidDecisionRunBinding(request, {
        ...boundResult,
        state: { ...boundResult.state, request: "a different Goalbraid decision request" },
      }),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "GOALBRAID_DECISION_RUN_BINDING_MISMATCH",
  );
});

test("publishes one immutable verified response and is idempotent", async () => {
  const { requestPath } = await fixturePath();
  const request = await loadGoalbraidDecisionRequest(requestPath);
  const result = fixturePublicationResult(request);
  const first = await publishGoalbraidDecisionResponse(
    requestPath,
    result,
    { outcome: "verified" },
    { now: () => new Date("2026-07-22T01:00:00.000Z") },
  );
  const second = await publishGoalbraidDecisionResponse(
    requestPath,
    result,
    { outcome: "verified" },
    { now: () => new Date("2026-07-22T02:00:00.000Z") },
  );

  assert.equal(first.outcome, "published");
  assert.equal(second.outcome, "already_published");
  assert.equal((await stat(first.responsePath)).mode & 0o077, 0);
  const response = JSON.parse(await readFile(first.responsePath, "utf8")) as Record<string, unknown>;
  assert.equal(response.controller, "cueline");
  assert.equal(response.completion_authority, "goalbraid");
  assert.deepEqual(response.decision, { decision: "select:goal-b" });
});

test("publisher rejects every request/run authority mismatch before creating a response", async (t) => {
  const cases = [
    {
      name: "different request prompt",
      overrides: { stateRequest: "a different Goalbraid decision request" },
    },
    {
      name: "different run id",
      overrides: { stateRunId: "cl-wrong-run" },
    },
    {
      name: "process executor",
      overrides: { executor: "process" as const },
    },
    {
      name: "process execution enabled",
      overrides: { allowProcessExecution: true },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const { root, requestPath } = await fixturePath();
      const request = await loadGoalbraidDecisionRequest(requestPath);
      await assert.rejects(
        publishGoalbraidDecisionResponse(
          requestPath,
          fixturePublicationResult(request, fixture.overrides),
          { outcome: "verified" },
        ),
        (error: unknown) =>
          error instanceof CueLineError &&
          error.code === "GOALBRAID_DECISION_RUN_BINDING_MISMATCH",
      );
      await assert.rejects(
        readFile(path.join(root, "responses", `${request.request_id}.json`), "utf8"),
        (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      );
    });
  }
});

test("refuses to publish degraded CueLine evidence", async () => {
  const { root, requestPath } = await fixturePath();
  const request = await loadGoalbraidDecisionRequest(requestPath);
  await assert.rejects(
    publishGoalbraidDecisionResponse(
      requestPath,
      fixturePublicationResult(request, {
        runId: "cl-degraded",
        finalDeliveryText: '{"decision":"human_required"}',
      }),
      { outcome: "degraded" },
    ),
    (error: unknown) =>
      error instanceof CueLineError && error.code === "GOALBRAID_DECISION_CUELINE_UNVERIFIED",
  );
  await assert.rejects(
    readFile(path.join(root, "responses", `${request.request_id}.json`), "utf8"),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
});
