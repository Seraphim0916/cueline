import assert from "node:assert/strict";
import test from "node:test";
import { lintControllerCommandText } from "../../dist/src/protocol/lint-command.js";
import { parseControllerCommand } from "../../dist/src/protocol/parse-command.js";
import { MAX_CONTROLLER_ENVELOPE_CHARS as limit } from "../../dist/src/protocol/limits.js";

const expected = { runId: "run_c25", round: 1, requestId: "msg_c25" };
const command = { protocol: "cueline/0.1", run_id: expected.runId, round: 1, request_id: expected.requestId, action: "complete", final_delivery_text: "" };
const payload = (length) => JSON.stringify({ ...command, final_delivery_text: "x".repeat(length - JSON.stringify(command).length) });
const envelope = (body) => `<CueLineControl>${body}</CueLineControl>`;

for (const [name, body, valid] of [
  ["exact limit", payload(limit), true],
  ["one character over", payload(limit + 1), false],
  ["surrounding whitespace at limit", ` \n${payload(limit - 4)}\n `, true],
  ["surrounding whitespace counts toward limit", ` \n${payload(limit - 3)}\n `, false],
  ["non BMP content counts UTF-16 code units", payload(limit - 2).replace('"final_delivery_text":"', '"final_delivery_text":"😀'), true],
]) {
  test(`envelope capacity: ${name}`, () => {
    const text = envelope(body);
    const result = lintControllerCommandText(text, { expected });
    assert.equal(result.format, "envelope");
    assert.equal(result.valid, valid);
    if (valid) {
      assert.deepEqual(result.command, parseControllerCommand(text, expected));
    } else {
      assert.deepEqual(result.issues.map((issue) => issue.code), ["CONTROL_ENVELOPE_TOO_LARGE"]);
      assert.equal(result.command, undefined);
      assert.throws(() => parseControllerCommand(text, expected), { code: "CONTROL_ENVELOPE_TOO_LARGE" });
    }
  });
}

test("outside text does not count and the last envelope still wins", () => {
  const small = envelope(payload(200));
  const large = envelope(payload(limit + 1));
  assert.equal(lintControllerCommandText("x".repeat(limit) + envelope(payload(limit)) + "y".repeat(limit), { expected }).valid, true);
  assert.equal(lintControllerCommandText(large + small, { expected }).valid, true);
  assert.equal(lintControllerCommandText(small + large, { expected }).issues[0]?.code, "CONTROL_ENVELOPE_TOO_LARGE");
});

test("raw JSON retains its existing capacity behavior", () => {
  const result = lintControllerCommandText(payload(limit + 1), { expected });
  assert.equal(result.format, "json");
  assert.equal(result.valid, true);
  assert.deepEqual(result.issues, []);
});

test("capacity error precedes malformed JSON error", () => {
  const result = lintControllerCommandText(envelope("!".repeat(limit + 1)), { expected });
  assert.equal(result.valid, false);
  assert.equal(result.issues[0]?.code, "CONTROL_ENVELOPE_TOO_LARGE");
});
