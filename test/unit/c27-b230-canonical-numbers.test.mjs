import assert from 'node:assert/strict';
import test from 'node:test';

const { canonicalJson, commandHash, jobSpecHash } = await import('../../src/core/ids.ts');

// 鎖住現有的數字表示：標準化 JSON 沿用 JSON.stringify 的最短往返寫法，負零寫成 0。
const CASES = [
  [5e-324, '5e-324'],
  [-5e-324, '-5e-324'],
  [Number.MIN_VALUE, '5e-324'],
  [1.7976931348623157e+308, '1.7976931348623157e+308'],
  [-Number.MAX_VALUE, '-1.7976931348623157e+308'],
  [Number.MAX_SAFE_INTEGER, '9007199254740991'],
  [Number.MIN_SAFE_INTEGER, '-9007199254740991'],
  [Number.MAX_SAFE_INTEGER + 1, '9007199254740992'],
  [-(Number.MAX_SAFE_INTEGER + 1), '-9007199254740992'],
  [1e21, '1e+21'],
  [1e-7, '1e-7'],
  [0.1 + 0.2, '0.30000000000000004'],
  [0, '0'],
  [-0, '0'],
];

for (const [value, text] of CASES) {
  test(`${Object.is(value, -0) ? '-0' : String(value)} canonicalizes to ${text} and round-trips`, () => {
    assert.equal(canonicalJson(value), text);
    const parsed = JSON.parse(text);
    assert.equal(canonicalJson(parsed), text);
    assert.equal(canonicalJson({ n: value, list: [value] }), `{"list":[${text}],"n":${text}}`);
    assert.equal(canonicalJson(JSON.parse(canonicalJson({ n: value }))), `{"n":${text}}`);
  });
}

test('positive and negative zero hash the same everywhere', () => {
  assert.equal(commandHash({ timeout_ms: 0 }), commandHash({ timeout_ms: -0 }));
  assert.equal(jobSpecHash([0, { a: -0 }]), jobSpecHash([-0, { a: 0 }]));
  assert.equal(canonicalJson(-0), canonicalJson(0));
});

test('distinct finite numbers keep distinct hashes at the edges', () => {
  assert.notEqual(commandHash(Number.MAX_SAFE_INTEGER), commandHash(Number.MAX_SAFE_INTEGER + 1));
  assert.notEqual(commandHash(5e-324), commandHash(0));
  assert.notEqual(commandHash(5e-324), commandHash(-5e-324));
});

for (const value of [NaN, Infinity, -Infinity]) {
  test(`${value} is still rejected, alone and nested`, () => {
    const rejected = { name: 'TypeError', message: 'CANONICAL_JSON_NON_FINITE_NUMBER' };
    assert.throws(() => canonicalJson(value), rejected);
    assert.throws(() => canonicalJson({ a: [1, value] }), rejected);
    assert.throws(() => commandHash({ n: value }), rejected);
  });
}
