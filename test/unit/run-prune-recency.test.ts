import assert from "node:assert/strict";
import test from "node:test";

import { classifyRunPruneRecency } from "../../src/api-run-prune.js";

const CUTOFF_MS = Date.parse("2026-07-19T00:00:00.000Z");

test("classifyRunPruneRecency marks a run older than the cutoff as eligible", () => {
  assert.equal(
    classifyRunPruneRecency("2026-07-18T00:00:00.000Z", CUTOFF_MS),
    "eligible",
  );
});

test("classifyRunPruneRecency keeps a run at or after the cutoff as too_recent", () => {
  // Boundary: equal to the cutoff is retained, matching the `>= cutoffMs` rule.
  assert.equal(
    classifyRunPruneRecency("2026-07-19T00:00:00.000Z", CUTOFF_MS),
    "too_recent",
  );
  assert.equal(
    classifyRunPruneRecency("2026-07-20T00:00:00.000Z", CUTOFF_MS),
    "too_recent",
  );
});

test("classifyRunPruneRecency reports an unparseable timestamp as its own reason", () => {
  for (const corrupt of ["not-a-date", "", "2026-13-45T99:99:99Z", "   "]) {
    assert.equal(
      classifyRunPruneRecency(corrupt, CUTOFF_MS),
      "unparseable_timestamp",
      `expected ${JSON.stringify(corrupt)} to be unparseable`,
    );
  }
});
