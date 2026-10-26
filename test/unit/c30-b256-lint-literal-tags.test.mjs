import assert from "node:assert/strict";
import test from "node:test";
import { lintControllerCommandText } from "../../dist/src/protocol/lint-command.js";
import { parseControllerCommand } from "../../dist/src/protocol/parse-command.js";
import { MAX_CONTROLLER_ENVELOPE_CHARS as limit } from "../../dist/src/protocol/limits.js";

const expected = { runId: "run_c30", round: 1, requestId: "msg_c30" };
const command = (text) => ({ protocol: "cueline/0.1", run_id: expected.runId,
  round: expected.round, request_id: expected.requestId, action: "complete", final_delivery_text: text });
const envelope = (body) => `<CueLineControl>${body}</CueLineControl>`;
const encode = (text) => envelope(JSON.stringify(command(text)));

function assertAccepted(input, text) {
  const parsed = parseControllerCommand(input, expected);
  assert.equal(parsed.final_delivery_text, text);
  const result = lintControllerCommandText(input, { expected });
  assert.equal(result.valid, true);
  assert.equal(result.format, "envelope");
  assert.deepEqual(result.command, parsed);
  assert.deepEqual(result.issues, []);
}

for (const text of [
  "literal </CueLineControl> content",
  "literal <CueLineControl> content",
  "literal <CueLineControl>{}</CueLineControl> content",
  'escaped " quote </CueLineControl> content',
  'backslash \\ and escaped \\" quote </CueLineControl> content',
  "trailing backslash \\",
]) {
  test(`literal tags and escapes: ${JSON.stringify(text)}`, () => assertAccepted(encode(text), text));
}

test("last complete envelope wins, including literal tags in both envelopes", () => {
  const last = 'last " </CueLineControl> <CueLineControl> content';
  assertAccepted(`prose ${encode("first </CueLineControl>")} between ${encode(last)} after`, last);
  assertAccepted(`${encode(last)}<CueLineControl>{`, last);
});

for (const body of ['{"final_delivery_text":"unterminated', '{"action":}', 'not JSON']) {
  test(`malformed last envelope must reject instead of replaying: ${body}`, () => {
    const input = encode("previous valid") + envelope(body);
    assert.throws(() => parseControllerCommand(input, expected), { code: "CONTROL_JSON_INVALID" });
    const result = lintControllerCommandText(input, { expected });
    assert.equal(result.valid, false);
    assert.equal(result.command, undefined);
    assert.equal(result.issues[0]?.code, "CONTROL_JSON_INVALID");
  });
}

test("raw JSON mode remains available", () => {
  const value = command('raw " quoted </CueLineControl> text');
  const result = lintControllerCommandText(JSON.stringify(value), { expected });
  assert.equal(result.valid, true);
  assert.equal(result.format, "json");
  assert.deepEqual(result.command, value);
});

test("literal closing tags cannot bypass the full envelope capacity check", () => {
  const prefix = "</CueLineControl>";
  const overhead = JSON.stringify(command(prefix)).length;
  for (const length of [limit, limit + 1]) {
    const text = prefix + "x".repeat(length - overhead);
    const body = JSON.stringify(command(text));
    assert.equal(body.length, length);
    const input = envelope(body);
    if (length === limit) assertAccepted(input, text);
    else {
      assert.throws(() => parseControllerCommand(input, expected), { code: "CONTROL_ENVELOPE_TOO_LARGE" });
      const result = lintControllerCommandText(input, { expected });
      assert.equal(result.valid, false);
      assert.equal(result.issues[0]?.code, "CONTROL_ENVELOPE_TOO_LARGE");
    }
  }
});
