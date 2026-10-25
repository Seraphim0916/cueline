import assert from 'node:assert/strict';
import test from 'node:test';
import { formatErrorMessage, asCueLineError } from '../../src/core/errors.ts';

const marker = '… [truncated]';
const boundary = 240 - marker.length;
for (const prefixLength of [boundary - 2, boundary - 1, boundary]) {
  test(`emoji at offset ${prefixLength} stays well formed at the truncation boundary`, () => {
    const input = 'a'.repeat(prefixLength) + '😀' + 'b'.repeat(30);
    const message = formatErrorMessage(input);
    const rendering = message.slice('Non-Error rejection (string): '.length);
    assert.equal(rendering.isWellFormed(), true);
    assert.ok(rendering.length <= 240);
    assert.equal(rendering, 'a'.repeat(prefixLength) +
      (prefixLength === boundary - 2 ? '😀' : '') + marker);
    assert.equal(asCueLineError(input).message, message);
  });
}

test('ASCII limit, untruncated Unicode, and genuine Error messages are preserved', () => {
  for (const input of ['a'.repeat(240), 'a'.repeat(238) + '😀']) {
    assert.equal(formatErrorMessage(input), `Non-Error rejection (string): ${input}`);
  }
  assert.equal(formatErrorMessage('a'.repeat(241)),
    `Non-Error rejection (string): ${'a'.repeat(boundary)}${marker}`);
  const message = 'a'.repeat(226) + '😀' + 'b'.repeat(300) + '\ud83d';
  assert.equal(formatErrorMessage(new Error(message)), message);
});

test('circular and failed serialization retain the fallback', () => {
  const circular = {};
  circular.self = circular;
  for (const input of [circular, { toJSON() { throw new Error('synthetic'); } },
    { toJSON() { return undefined; } }]) {
    assert.equal(formatErrorMessage(input), 'Non-Error rejection (object): [unserializable value]');
  }
});
