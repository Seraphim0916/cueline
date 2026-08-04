import assert from "node:assert/strict";
import test from "node:test";

import {
  exactControllerEnvelopeText,
  hasExactControllerEnvelopeIdentity,
  latestControllerEnvelopeIdentity,
} from "../../src/browser/codex-iab/recovery-evidence.js";
import type { ExpectedControllerIdentity } from "../../src/protocol/types.js";

const expected: ExpectedControllerIdentity = {
  runId: "run_unclosed_recovery",
  round: 198,
  requestId: "msg_unclosed_recovery",
};

function controllerJson(
  overrides: Partial<Record<"run_id" | "round" | "request_id", string | number>> = {},
): string {
  return JSON.stringify({
    protocol: "cueline/0.1",
    run_id: expected.runId,
    round: expected.round,
    request_id: expected.requestId,
    action: "inspect",
    ...overrides,
  });
}

test("accepts one complete unclosed controller object at end of response", () => {
  const body = controllerJson();
  const text = `<CueLineControl>\n${body}`;

  assert.equal(
    exactControllerEnvelopeText(text, expected),
    `<CueLineControl>${body}</CueLineControl>`,
  );
  assert.equal(hasExactControllerEnvelopeIdentity(text, expected), true);
  assert.deepEqual(latestControllerEnvelopeIdentity(text), expected);
});

test("keeps paired controller-envelope behavior unchanged", () => {
  const body = controllerJson();
  const text = `Intro\n<CueLineControl>${body}</CueLineControl>\nFollow-up`;

  assert.equal(
    exactControllerEnvelopeText(text, expected),
    `<CueLineControl>${body}</CueLineControl>`,
  );
});

test("rejects unclosed fallback with non-terminal, malformed, or ambiguous text", () => {
  const body = controllerJson();
  const rejected = [
    `Intro\n<CueLineControl>\n${body}`,
    `<CueLineControl>\n${body}\ntrailing text`,
    `<CueLineControl>\n${body.slice(0, -1)}`,
    `<CueLineControl>\n${body}\n<CueLineControl>\n${body}`,
  ];

  for (const text of rejected) {
    assert.equal(exactControllerEnvelopeText(text, expected), null, text);
    assert.equal(hasExactControllerEnvelopeIdentity(text, expected), false, text);
    assert.equal(latestControllerEnvelopeIdentity(text), null, text);
  }
});

test("requires the unclosed object to match the expected identity", () => {
  const text = `<CueLineControl>\n${controllerJson({ request_id: "msg_other" })}`;

  assert.equal(exactControllerEnvelopeText(text, expected), null);
  assert.equal(hasExactControllerEnvelopeIdentity(text, expected), false);
  assert.deepEqual(latestControllerEnvelopeIdentity(text), {
    ...expected,
    requestId: "msg_other",
  });
});
