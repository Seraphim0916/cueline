import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const sourceRoot = new URL('../../src/', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot)
        && specifier.startsWith('.') && specifier.endsWith('.js')) {
      return nextResolve(specifier.slice(0, -3) + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
});
let jobStatusRecordIsLegacy, isLegacyJobStatusSource;
try {
  ({ jobStatusRecordIsLegacy, isLegacyJobStatusSource } = await import('../../src/jobs/status.ts'));
} finally {
  hooks.deregister();
}

for (const [name, detect] of [
  ['record', jobStatusRecordIsLegacy],
  ['source', value => isLegacyJobStatusSource(JSON.stringify(value))],
]) {
  test(`${name} rejects root and result arrays`, () => {
    for (const value of [[], [{ result: {} }], { result: [] }, { result: [{}] }]) {
      assert.equal(detect(value), false, JSON.stringify(value));
    }
  });
  test(`${name} preserves partial legacy objects and current evidence`, () => {
    for (const value of [{ result: {} }, { result: { output: 'old' } }]) {
      assert.equal(detect(value), true);
    }
    for (const value of [{}, { result: null }, { result: { cancelled: false } },
      { result: { cancelled: true } }]) {
      assert.equal(detect(value), false);
    }
  });
}

test('record rejects an array even when it carries a legacy-shaped result property', () => {
  const root = [];
  root.result = {};
  assert.equal(jobStatusRecordIsLegacy(root), false);
});
