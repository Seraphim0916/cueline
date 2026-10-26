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
let evidence;
try {
  ({ acceptedControllerCommandEvidence: evidence } = await import('../../src/core/run-status.ts'));
} finally {
  hooks.deregister();
}

const accepted = (command) => ({ type: 'controller_command_accepted', payload: { command } });
const old = accepted({
  action: 'dispatch', request_id: 'old',
  jobs: [{ job_key: 'a' }, null, 3, 'ignored', [], {}, { job_key: 7 },
    { job_key: false }, { job_key: null }, { job_key: 'b' }],
});
const invalidEvents = [
  accepted({ action: 'unknown', request_id: 'new' }),
  ...[undefined, null, [], 'dispatch', 42, true].map(accepted),
  { type: 'unrelated', payload: { command: { action: 'complete', request_id: 'new' } } },
];

test('invalid trailing events fall back to the latest valid command', () => {
  const expected = { action: 'dispatch', requestId: 'old', jobKeys: ['a', 'b'] };
  const earlier = accepted({ action: 'wait', request_id: 'earlier' });
  for (const event of invalidEvents) {
    assert.deepEqual(evidence([earlier, old, event]), expected);
  }
  assert.deepEqual(evidence([earlier, old, ...invalidEvents]), expected);
  console.log(JSON.stringify(evidence([old, invalidEvents[0]])));
});

test('string job keys keep order, duplicates, and empty strings', () => {
  assert.deepEqual(evidence([accepted({ action: 'dispatch', request_id: 5,
    jobs: [{ job_key: 'b' }, { job_key: '' }, { job_key: 'a' }, { job_key: 'b' }],
  })]), { action: 'dispatch', requestId: null, jobKeys: ['b', '', 'a', 'b'] });
});

test('no valid accepted event produces the empty three-field summary', () => {
  const empty = { action: null, requestId: null, jobKeys: [] };
  assert.deepEqual(evidence([]), empty);
  assert.deepEqual(evidence(invalidEvents), empty);
});
