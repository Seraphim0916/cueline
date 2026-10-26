import assert from "node:assert/strict";
import test from "node:test";
import { lintControllerCommandText } from "../../dist/src/protocol/lint-command.js";

const expected = { runId: "run_c25", round: 1, requestId: "msg_c25" };
const base = { protocol: "cueline/0.1", run_id: expected.runId, round: 1, request_id: expected.requestId };

for (const format of ["json", "envelope"]) {
  const encode = (value) => format === "json" ? JSON.stringify(value)
    : `<CueLineControl>${JSON.stringify(value)}</CueLineControl>`;
  for (const action of ["constructor", "__proto__", "toString"]) {
    test(`${format}: inherited action ${action} returns a controlled error`, () => {
      const result = lintControllerCommandText(encode({ ...base, action, wait_ms: 1 }), { expected });
      assert.equal(result.valid, false);
      assert.equal(result.format, format);
      assert.equal(result.command, undefined);
      assert.ok(result.issues.some((issue) => issue.code === "CONTROL_COMMAND_INVALID"));
    });
  }
  test(`${format}: valid wait and disallowed action fields retain their behavior`, () => {
    const valid = lintControllerCommandText(encode({ ...base, action: "wait", wait_ms: 1 }), { expected });
    assert.equal(valid.valid, true);
    assert.equal(valid.command.wait_ms, 1);
    assert.deepEqual(valid.issues, []);
    const invalid = lintControllerCommandText(encode({ ...base, action: "complete", final_delivery_text: "done", wait_ms: 1 }), { expected });
    assert.equal(invalid.valid, false);
    assert.ok(invalid.issues.some((issue) => issue.code === "CONTROL_FIELD_NOT_ALLOWED_FOR_ACTION"));
  });
}
