import assert from 'node:assert/strict';
import test from 'node:test';
import {
  capControllerEvidence,
  capReplayedControllerEvidence,
} from '../../src/core/controller-evidence.ts';

const maximum = 4;
const original = 'HEADTAIL';
const capped = capControllerEvidence(original, maximum);

test('an exact trailing durable marker preserves the original total and text', () => {
  assert.deepEqual(capped, {
    value: 'HEAD\n...[job evidence capped: 4 chars omitted; total_chars=8; cap=4]',
    totalChars: 8,
    truncatedChars: 4,
  });
  assert.deepEqual(capReplayedControllerEvidence(capped.value, original.length, maximum), capped);
});

for (const [name, suffix] of [
  ['LF', '\n'], ['CR', '\r'], ['CRLF', '\r\n'],
  ['U+2028', '\u2028'], ['U+2029', '\u2029'], ['space', ' '],
]) {
  test(`a marker followed by ${name} is capped again using the actual input length`, () => {
    const value = capped.value + suffix;
    const replayed = capReplayedControllerEvidence(value, original.length, maximum);
    assert.deepEqual(replayed, capControllerEvidence(value, maximum));
    assert.notEqual(replayed.value, value);
    assert.equal(replayed.totalChars, value.length);
    assert.notEqual(replayed.totalChars, original.length);
    assert.equal(replayed.truncatedChars, value.length - maximum);
  });
}
