import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { loadRoutingConfig } from "../../src/router/config-loader.js";

// Guards the shipped turnkey example (config/routing.multimodel.example.json)
// against schema drift: it must always load through CueLine's real routing
// loader and keep its documented provider shape.
const EXAMPLE = path.resolve("config/routing.multimodel.example.json");

test("the shipped multi-model example routing config loads and validates", async () => {
  const config = await loadRoutingConfig(EXAMPLE);
  assert.equal(config.version, 1);
  assert.deepEqual(Object.keys(config.lanes).sort(), ["default", "taste-final"]);
});

test("the example keeps the bundled Codex work route on the default lane", async () => {
  const config = await loadRoutingConfig(EXAMPLE);
  const def = config.lanes.default;
  assert.equal(def?.enabled, true);
  assert.equal(def?.candidates.length, 1);
  assert.equal(def?.candidates[0]?.id, "codex-default");
  assert.equal(def?.candidates[0]?.argv[0], "codex");
  assert.equal(def?.candidates[0]?.task_input, "stdin");
});

test("the example adds a Claude advise-only provider with no mutating placeholder", async () => {
  const config = await loadRoutingConfig(EXAMPLE);
  const lane = config.lanes["taste-final"];
  assert.equal(lane?.enabled, true);
  const claude = lane?.candidates[0];
  assert.equal(claude?.id, "claude-opus-4-8-advise");
  assert.equal(claude?.argv[0], "claude");
  assert.equal(claude?.task_input, "argv");
  // Advise-only by construction: a hardcoded read-only tool allow-list and no
  // {sandbox}/{mode} placeholder, so this provider can never be handed a
  // mutating job even if a controller selects it.
  assert.ok(claude?.argv.includes("Read"));
  assert.equal(claude?.argv.some((part) => part.includes("{sandbox}")), false);
  assert.equal(claude?.argv.some((part) => part.includes("{mode}")), false);
});
