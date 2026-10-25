import assert from "node:assert/strict";
import test from "node:test";

import { controllerEvidenceCapacityNotice } from "../../dist/src/core/controller-evidence.js";

for (const budget of [1, 37, 250]) {
  test(`last round retains one budget and exhausted rounds retain zero: ${budget}`, () => {
    const lastRound = 4;
    const outcomes = [
      controllerEvidenceCapacityNotice(budget, lastRound, lastRound, budget),
      controllerEvidenceCapacityNotice(budget + 1, lastRound, lastRound, budget),
      controllerEvidenceCapacityNotice(0, lastRound + 1, lastRound, budget),
      controllerEvidenceCapacityNotice(1, lastRound + 1, lastRound, budget),
    ];
    assert.deepEqual(outcomes.map((value) => value === undefined ? undefined : true),
      [undefined, true, undefined, true]);
    assert.match(outcomes[1], new RegExp(`evidence total ${budget + 1} chars exceeds remaining round capacity ${budget} chars`));
    assert.match(outcomes[3], /evidence total 1 chars exceeds remaining round capacity 0 chars/);
    assert.equal(controllerEvidenceCapacityNotice(0, lastRound + 20, lastRound, budget), undefined);
    assert.match(controllerEvidenceCapacityNotice(1, lastRound + 20, lastRound, budget),
      /remaining round capacity 0 chars/);
  });
}

test("custom budget counts both the current and final rounds", () => {
  assert.equal(controllerEvidenceCapacityNotice(74, 3, 4, 37), undefined);
  assert.match(controllerEvidenceCapacityNotice(75, 3, 4, 37), /remaining round capacity 74 chars/);
});

test("unlimited rounds never warn even with evidence beyond a custom budget", () => {
  for (const round of [1, 4, 5, 100]) {
    assert.equal(controllerEvidenceCapacityNotice(Number.MAX_SAFE_INTEGER, round, null, 1), undefined);
  }
});
