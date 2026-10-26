import assert from "node:assert/strict";
import test from "node:test";
import { preferredControllerEvidence } from "../../dist/src/core/controller-turn.js";

for (const status of ["succeeded", "failed", "running", "pending", "cancelled", "timed_out", "ambiguous"]) {
  const preferred = status === "succeeded" ? "output" : "error";
  const fallback = preferred === "output" ? "error" : "output";
  test(`${status}: empty preferred evidence is retained, not replaced by fallback`, () => {
    const job = Object.freeze({ status, [preferred]: "", [fallback]: "fallback text" });
    assert.deepEqual(preferredControllerEvidence(job), { field: preferred, value: "" });
    assert.deepEqual(preferredControllerEvidence({ status, [preferred]: "preferred text", [fallback]: "fallback text" }),
      { field: preferred, value: "preferred text" });
  });
  test(`${status}: only undefined selects fallback, including an empty fallback`, () => {
    for (const value of ["fallback text", ""]) {
      assert.deepEqual(preferredControllerEvidence({ status, [preferred]: undefined, [fallback]: value }),
        { field: fallback, value });
      assert.deepEqual(preferredControllerEvidence({ status, [fallback]: value }),
        { field: fallback, value });
    }
    assert.equal(preferredControllerEvidence({ status }), undefined);
    assert.equal(preferredControllerEvidence({ status, output: undefined, error: undefined }), undefined);
  });
}
