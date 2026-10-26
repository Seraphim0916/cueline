import assert from 'node:assert/strict';
import test from 'node:test';
import { asCueLineError, formatErrorMessage } from '../../src/core/errors.ts';

for (const [name, makeValue] of [
  ['undefined from toJSON', () => ({ toJSON() { return undefined; } })],
  ['nested BigInt', () => ({ nested: { value: 1n } })],
  ['throwing enumerable getter', () => Object.defineProperty({}, 'value', {
    enumerable: true,
    get() { throw new Error('getter failed'); },
  })],
]) {
  test(`${name} retains fallback, original cause, and requested code`, () => {
    const cause = makeValue();
    const expected = 'Non-Error rejection (object): [unserializable value]';
    assert.equal(formatErrorMessage(cause), expected);
    const error = asCueLineError(cause, 'SERIALIZATION_FIXTURE');
    assert.equal(error.message, expected);
    assert.strictEqual(error.cause, cause);
    assert.equal(error.code, 'SERIALIZATION_FIXTURE');
  });
}
