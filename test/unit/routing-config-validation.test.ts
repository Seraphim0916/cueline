import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CueLineError } from "../../src/core/errors.js";
import { loadRoutingConfig, parseRoutingConfig } from "../../src/router/config-loader.js";

// parseRoutingConfig is the surface every provider (routing candidate) is
// defined through. A malformed provider definition must fail closed with a
// specific, actionable message rather than silently loading a half-formed lane.
function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "worker-advise", argv: ["worker", "{task}"], task_input: "argv", ...overrides };
}

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    lanes: { default: { enabled: true, candidates: [candidate()] } },
    ...overrides,
  };
}

function laneWith(candidateValue: unknown): Record<string, unknown> {
  return { lanes: { default: { enabled: true, candidates: [candidateValue] } } };
}

function rejects(value: unknown, messagePattern: RegExp): void {
  assert.throws(
    () => parseRoutingConfig(value),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "ROUTING_CONFIG_INVALID" &&
      messagePattern.test(error.message),
  );
}

test("rejects a routing configuration that is not a plain object", () => {
  for (const bad of [null, 42, "config", [config()]]) {
    rejects(bad, /routing configuration must be an object/);
  }
});

test("rejects unsupported fields at config, lane, and candidate scope", () => {
  rejects(config({ bogus: 1 }), /routing configuration contains unsupported field 'bogus'/);
  rejects(
    { version: 1, lanes: { default: { enabled: true, candidates: [candidate()], bogus: 1 } } },
    /lane configuration contains unsupported field 'bogus'/,
  );
  rejects(config(laneWith(candidate({ bogus: 1 }))), /route candidate contains unsupported field 'bogus'/);
});

test("rejects a non-string $schema and any version other than the integer 1", () => {
  rejects(config({ $schema: 1 }), /\$schema must be a string/);
  rejects(config({ version: 2 }), /version must be 1/);
  rejects(config({ version: "1" }), /version must be 1/);
});

test("rejects missing, empty, or non-record lanes", () => {
  rejects(config({ lanes: {} }), /must define at least one lane/);
  rejects(config({ lanes: 42 }), /must define at least one lane/);
  rejects(config({ lanes: [] }), /must define at least one lane/);
});

test("rejects a lane name outside the controller-safe pattern", () => {
  rejects(
    { version: 1, lanes: { "bad name!": { enabled: true, candidates: [candidate()] } } },
    /lane name contains unsupported characters/,
  );
});

test("rejects malformed lane objects", () => {
  rejects({ version: 1, lanes: { default: 42 } }, /lane configuration must be an object/);
  rejects(
    { version: 1, lanes: { default: { enabled: "yes", candidates: [candidate()] } } },
    /lane enabled must be a boolean/,
  );
  rejects(
    { version: 1, lanes: { default: { enabled: true, candidates: [] } } },
    /lane candidates must be a non-empty array/,
  );
  rejects(
    { version: 1, lanes: { default: { enabled: true, candidates: "nope" } } },
    /lane candidates must be a non-empty array/,
  );
});

test("rejects every malformed candidate shape with a field-specific message", () => {
  rejects(config(laneWith(42)), /route candidate must be an object/);
  rejects(config(laneWith(candidate({ id: 1 }))), /candidate id must be a non-empty string/);
  rejects(config(laneWith(candidate({ id: "   " }))), /candidate id must be a non-empty string/);
  rejects(config(laneWith(candidate({ argv: [] }))), /argv must contain non-empty strings/);
  rejects(config(laneWith(candidate({ argv: "worker" }))), /argv must contain non-empty strings/);
  rejects(config(laneWith(candidate({ argv: ["worker", ""] }))), /argv must contain non-empty strings/);
  rejects(config(laneWith(candidate({ argv: ["worker", 3] }))), /argv must contain non-empty strings/);
  rejects(config(laneWith(candidate({ enabled: "yes" }))), /candidate enabled must be a boolean/);
  rejects(config(laneWith(candidate({ task_input: "pipe" }))), /task_input must be argv or stdin/);
});

test("rejects duplicate candidate ids within a lane", () => {
  rejects(
    { version: 1, lanes: { default: { enabled: true, candidates: [candidate(), candidate()] } } },
    /lane candidate ids must be unique/,
  );
});

test("accepts a minimal config and omits absent optional candidate fields", () => {
  const parsed = parseRoutingConfig({
    version: 1,
    lanes: { default: { enabled: true, candidates: [{ id: "x", argv: ["worker"] }] } },
  });
  assert.deepEqual(parsed, {
    version: 1,
    lanes: { default: { enabled: true, candidates: [{ id: "x", argv: ["worker"] }] } },
  });
});

test("accepts optional candidate fields and drops the editor-only $schema", () => {
  const parsed = parseRoutingConfig({
    $schema: "./routing.schema.json",
    version: 1,
    lanes: { default: { enabled: true, candidates: [candidate({ enabled: false })] } },
  });
  assert.equal("$schema" in parsed, false);
  assert.equal(parsed.lanes.default?.candidates[0]?.task_input, "argv");
  assert.equal(parsed.lanes.default?.candidates[0]?.enabled, false);
});

test("copies candidate argv so later mutation of the input cannot reach parsed state", () => {
  const argv = ["worker", "{task}"];
  const parsed = parseRoutingConfig({
    version: 1,
    lanes: { default: { enabled: true, candidates: [{ id: "x", argv }] } },
  });
  argv.push("--leak");
  assert.deepEqual(parsed.lanes.default?.candidates[0]?.argv, ["worker", "{task}"]);
});

test("loadRoutingConfig maps an unreadable file and invalid JSON to distinct codes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cueline-routing-"));
  await assert.rejects(
    loadRoutingConfig(path.join(dir, "missing.json")),
    (error: unknown) => error instanceof CueLineError && error.code === "ROUTING_CONFIG_READ_FAILED",
  );
  const badJson = path.join(dir, "bad.json");
  await writeFile(badJson, "{ not json", "utf8");
  await assert.rejects(
    loadRoutingConfig(badJson),
    (error: unknown) =>
      error instanceof CueLineError &&
      error.code === "ROUTING_CONFIG_INVALID" &&
      /not valid JSON/.test(error.message),
  );
});
