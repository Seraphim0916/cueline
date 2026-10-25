import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson } from '../../src/core/ids.ts';

test('shared objects in sibling branches serialize like independent copies', () => {
  const shared = { x: 1 };
  const actual = canonicalJson({ b: shared, a: shared });
  assert.equal(actual, '{"a":{"x":1},"b":{"x":1}}');
  assert.equal(actual, canonicalJson({ a: { x: 1 }, b: { x: 1 } }));
});

test('ancestor cleanup allows repeated objects and arrays across alternating branches', () => {
  const leaf = { x: 1 };
  const array = [leaf, { nested: [leaf] }];
  const value = { a: array, b: { items: array, leaf }, c: [array, leaf] };
  const copy = JSON.parse(JSON.stringify(value));
  assert.notEqual(copy.a, copy.b.items);
  assert.equal(canonicalJson(value), canonicalJson(copy));
  assert.equal(canonicalJson([array, array]),
    '[[{"x":1},{"nested":[{"x":1}]}],[{"x":1},{"nested":[{"x":1}]}]]');
});

test('direct object and array cycles are rejected', () => {
  const object = {};
  object.self = object;
  const array = [];
  array.push(array);
  for (const value of [object, array]) {
    assert.throws(() => canonicalJson(value), {
      name: 'TypeError', message: 'CANONICAL_JSON_CYCLE',
    });
  }
});

test('indirect cycles through alternating objects and arrays are rejected', () => {
  const object = { children: [] };
  object.children.push({ parent: object });
  const array = [{ children: [] }];
  array[0].children.push(array);
  for (const value of [object, array]) {
    assert.throws(() => canonicalJson(value), {
      name: 'TypeError', message: 'CANONICAL_JSON_CYCLE',
    });
  }
});
