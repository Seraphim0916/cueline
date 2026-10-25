import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
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
let buildCueLineRunTimeline;
try {
  ({ buildCueLineRunTimeline } = await import('../../src/observation/run-timeline.ts'));
} finally {
  hooks.deregister();
}

function entry(payload) {
  const before = structuredClone(payload);
  const result = buildCueLineRunTimeline('run_test', [{ sequence: 1,
    timestamp: '2026-10-26T00:00:00Z', type: 'controller_round_progress', payload,
  }], tmpdir()).entries[0];
  assert.deepEqual(payload, before, 'original event payload remains unchanged');
  return result;
}

test('progress and stagnation attributes agree with timeline summaries', () => {
  const progressing = entry({ progressed: true, stagnant_rounds: 0, futurePrivateField: 'synthetic' });
  assert.deepEqual(progressing.attributes, { progressed: true, stagnant_rounds: 0 });
  assert.equal(progressing.summary, 'Controller round changed structured output or observed evidence.');
  const stagnant = entry({ progressed: false, stagnant_rounds: 3 });
  assert.deepEqual(stagnant.attributes, { progressed: false, stagnant_rounds: 3 });
  assert.equal(stagnant.summary, 'Controller round made no observable progress (3 consecutive).');
  assert.equal(entry({ stagnant_rounds: Number.MAX_SAFE_INTEGER }).attributes.stagnant_rounds,
    Number.MAX_SAFE_INTEGER);
});

test('invalid types and unsafe stagnation counts remain omitted', () => {
  for (const progressed of [undefined, null, 0, 1, 'true', {}, []]) {
    assert.deepEqual(entry({ progressed }).attributes, {});
  }
  for (const stagnant_rounds of [undefined, null, true, '3', -1, 0.5, NaN, Infinity,
    Number.MAX_SAFE_INTEGER + 1, {}, []]) {
    assert.deepEqual(entry({ stagnant_rounds }).attributes, {});
  }
  assert.deepEqual(entry({}).attributes, {});
});
