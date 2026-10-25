import assert from 'node:assert/strict';
import test from 'node:test';
import { isSafeRuntimeGeneration } from '../../src/state/runtime-record-validation.ts';

test('generation accepts the complete ASCII alphabet and 128-character boundary', () => {
  for (const first of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') {
    for (const value of [first, `${first}Az09_-`, first + '_'.repeat(127)]) {
      assert.equal(isSafeRuntimeGeneration(value), true, JSON.stringify(value));
    }
  }
  assert.equal(isSafeRuntimeGeneration('epoch'), true);
  assert.equal(isSafeRuntimeGeneration('a'.repeat(129)), false);
});

test('generation rejects invalid first characters, separators and slash variants', () => {
  for (const value of ['', '_epoch', '-epoch', 'époch', '😀epoch', '/epoch',
    'epoch/path', 'epoch\\path', 'epoch.path', 'epoch path', ' epoch', 'epoch ']) {
    assert.equal(isSafeRuntimeGeneration(value), false, JSON.stringify(value));
  }
  for (const separator of ['\n', '\r', '\r\n', '\u2028', '\u2029', '\t']) {
    for (const value of [`epoch${separator}`, `${separator}epoch`, `ep${separator}och`,
      `${'a'.repeat(128)}${separator}`]) {
      assert.equal(isSafeRuntimeGeneration(value), false, JSON.stringify(value));
    }
  }
});

test('generation rejects non-strings without coercion', () => {
  for (const value of [undefined, null, true, false, 0, 123, NaN, Infinity, 1n,
    Symbol('epoch'), [], ['epoch'], {}, new String('epoch'), () => 'epoch',
    { toString() { throw new Error('must not coerce'); } }]) {
    assert.equal(isSafeRuntimeGeneration(value), false);
  }
});
