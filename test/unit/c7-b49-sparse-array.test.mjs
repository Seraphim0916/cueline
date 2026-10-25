import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = await readFile(new URL('../../src/core/ids.ts', import.meta.url), 'utf8');
const { canonicalJson, jobSpecHash } = await import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`);

for (const [name, value] of [
  ['single hole', Array(1)], ['all holes', Array(2)],
  ['leading', [, 2]], ['middle', [1, , 3]], ['trailing', [1, ,]],
  ['nested', { a: [1, [, 2]] }],
]) {
  test(`rejects ${name}`, () => {
    for (const encode of [canonicalJson, jobSpecHash]) {
      assert.throws(() => encode(value), { name: 'TypeError', message: 'CANONICAL_JSON_SPARSE_ARRAY' });
    }
  });
}
test('inherited indices do not fill holes', () => {
  const value = Array(1);
  Object.setPrototypeOf(value, Object.assign(Object.create(Array.prototype), { 0: 1 }));
  assert.throws(() => canonicalJson(value), /CANONICAL_JSON_SPARSE_ARRAY/);
});
test('dense serialization and hashes stay stable', () => {
  for (const [value, expected] of [[[], '[]'], [[1, null, { b: 2, a: true }], '[1,null,{"a":true,"b":2}]']]) {
    assert.equal(canonicalJson(value), expected);
    assert.equal(jobSpecHash(value), createHash('sha256').update(expected).digest('hex'));
  }
});
test('unsupported values and cycles remain rejected; shared values are allowed', () => {
  for (const value of [undefined, () => {}, Symbol('fake')]) {
    assert.throws(() => canonicalJson([value]), /CANONICAL_JSON_UNSUPPORTED_/);
  }
  const cyclic = []; cyclic.push(cyclic);
  assert.throws(() => canonicalJson(cyclic), /CANONICAL_JSON_CYCLE/);
  const shared = [1];
  assert.equal(canonicalJson([shared, shared]), '[[1],[1]]');
});
