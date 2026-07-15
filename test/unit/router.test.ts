import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { CueLineError } from "../../src/core/errors.js";
import { parseRoutingConfig } from "../../src/router/config-loader.js";
import { executableAvailability } from "../../src/router/availability.js";
import { materializeRunnerSpec } from "../../src/router/materialize.js";
import { resolveRoute } from "../../src/router/resolver.js";
import type { RoutingConfig } from "../../src/router/types.js";

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof CueLineError && error.code === code;
}

function config(): RoutingConfig {
  return {
    version: 1,
    lanes: {
      triage: {
        enabled: true,
        candidates: [
          { id: "first", argv: ["first-runner"] },
          { id: "second", argv: ["second-runner"] },
          { id: "third", argv: ["third-runner"] },
        ],
      },
      disabled: {
        enabled: false,
        candidates: [{ id: "never", argv: ["never-runner"] }],
      },
    },
  };
}

test("selects the first available candidate in declared order before spawn", () => {
  const route = resolveRoute("triage", config(), {
    first: false,
    second: true,
    third: true,
  });

  assert.equal(route.lane, "triage");
  assert.equal(route.candidate.id, "second");
  assert.equal(route.candidateIndex, 1);
});

test("skips disabled candidates while retaining deterministic fallback order", () => {
  const route = resolveRoute(
    "triage",
    {
      version: 1,
      lanes: {
        triage: {
          enabled: true,
          candidates: [
            { id: "disabled", argv: ["disabled-runner"], enabled: false },
            { id: "available", argv: ["available-runner"] },
          ],
        },
      },
    },
    { disabled: true, available: true },
  );

  assert.equal(route.candidate.id, "available");
});

test("rejects disabled lanes", () => {
  assert.throws(() => resolveRoute("disabled", config(), {}), hasCode("ROUTE_LANE_DISABLED"));
});

test("rejects unknown lanes", () => {
  assert.throws(() => resolveRoute("missing", config(), {}), hasCode("ROUTE_LANE_UNKNOWN"));
});

test("explains when a runner ID was supplied as the lane", () => {
  assert.throws(
    () => resolveRoute("second", config(), {}),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "ROUTE_LANE_UNKNOWN" &&
      /runner ID/i.test(error.message) &&
      /lane 'triage'/.test(error.message) &&
      /runner 'second'/.test(error.message),
  );
});

test("rejects a lane when every candidate is unavailable before spawn", () => {
  assert.throws(
    () => resolveRoute("triage", config(), { first: false, second: false, third: false }),
    hasCode("ROUTE_NO_CANDIDATE"),
  );
});

test("honors an explicitly requested available runner without trying earlier candidates", () => {
  const route = resolveRoute(
    "triage",
    config(),
    { first: true, second: true, third: true },
    "third",
  );

  assert.equal(route.candidate.id, "third");
  assert.equal(route.candidateIndex, 2);
});

test("rejects an explicitly requested unavailable runner before spawn", () => {
  assert.throws(
    () => resolveRoute("triage", config(), { first: true, second: false }, "second"),
    hasCode("ROUTE_RUNNER_UNAVAILABLE"),
  );
});

test("validates routing configuration before it can be resolved", () => {
  assert.throws(
    () => parseRoutingConfig({ version: 1, lanes: { triage: { enabled: true, candidates: [{ id: "bad", argv: [] }] } } }),
    hasCode("ROUTING_CONFIG_INVALID"),
  );
});

test("checks executables directly without invoking a shell", () => {
  const available = executableAvailability({ PATH: path.dirname(process.execPath) });

  assert.equal(available.isAvailable({ id: "node", argv: [path.basename(process.execPath)] }, "triage"), true);
  assert.equal(available.isAvailable({ id: "missing", argv: ["cueline-definitely-missing"] }, "triage"), false);
});

test("materializes mode-safe argv tokens and stdin task input", () => {
  const spec = materializeRunnerSpec(
    "job_1",
    {
      job_key: "worker",
      lane: "triage",
      mode: "work",
      task: "Implement safely",
      workdir: "/tmp/example",
      timeout_ms: 12_345,
      background: true,
    },
    {
      lane: "triage",
      candidateIndex: 0,
      candidate: {
        id: "codex",
        argv: ["codex", "exec", "-C", "{workdir}", "-s", "{sandbox}", "-"],
        task_input: "stdin",
      },
    },
  );

  assert.deepEqual(spec.argv, ["codex", "exec", "-C", "/tmp/example", "-s", "workspace-write", "-"]);
  assert.equal(spec.stdin, "Implement safely");
  assert.equal(spec.cwd, "/tmp/example");
  assert.equal(spec.timeoutMs, 12_345);
  assert.equal(spec.background, true);
  assert.equal((spec as typeof spec & { runnerId?: string }).runnerId, "codex");
});

test("materializes an argv task only at an explicit placeholder", () => {
  const spec = materializeRunnerSpec(
    "job_argv",
    { job_key: "worker", lane: "triage", mode: "advise", task: "Inspect only" },
    {
      lane: "triage",
      candidateIndex: 0,
      candidate: { id: "custom", argv: ["worker", "--task", "{task}"], task_input: "argv" },
    },
    { cwd: "/tmp/default" },
  );

  assert.deepEqual(spec.argv, ["worker", "--task", "Inspect only"]);
  assert.equal(spec.stdin, undefined);
});

test("rejects an argv task template that never places the task", () => {
  assert.throws(
    () =>
      materializeRunnerSpec(
        "job_bad",
        { job_key: "worker", lane: "triage", mode: "advise", task: "Inspect" },
        {
          lane: "triage",
          candidateIndex: 0,
          candidate: { id: "bad", argv: ["worker"], task_input: "argv" },
        },
      ),
    hasCode("ROUTE_TEMPLATE_TASK_MISSING"),
  );
});
