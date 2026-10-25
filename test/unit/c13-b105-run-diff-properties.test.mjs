import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

// Replace only status I/O; load the actual public comparison implementation.
const readerUrl = `data:text/javascript,${encodeURIComponent(`
  const statuses = new Map();
  export function setStatus(status) { statuses.set(status.runId, status); }
  export async function loadCueLineRunStatus(id) {
    if (!statuses.has(id)) throw new Error('Unexpected run: ' + id);
    return structuredClone(statuses.get(id));
  }
`)}`;
const { setStatus } = await import(readerUrl);
const sourceUrl = new URL('../../src/observation/run-diff.ts', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === sourceUrl && specifier === '../api-runtime-lifecycle.js') {
      return { url: readerUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
let compareCueLineRuns;
try {
  ({ compareCueLineRuns } = await import(sourceUrl));
} finally {
  hooks.deregister();
}

function status(runId, overrides = {}) {
  return {
    runId, status: 'running', executor: 'fake', allowProcessExecution: false,
    phase: 'observe', round: 0, maxRounds: 5, maxStagnantRounds: 3,
    stagnantRounds: 0, lastEventSequence: 0, runtime: { ownership: 'none' },
    cancellation: { runRequested: false },
    controller: { pendingTurns: 0, acceptedCommands: 0, archive: { status: 'none' } },
    jobs: { total: 3, counts: { running: 1, queued: 2 } },
    continueAllowed: true, safeNextAction: 'wait', ...overrides,
  };
}

test('self comparison has no changes and preserves both projections', async () => {
  setStatus(status('self'));
  const result = await compareCueLineRuns('self', 'self');
  assert.equal(result.equivalent, true);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.left, result.right);
  assert.equal(result.left.runId, 'self');
});

test('swapping runs swaps only values and projections, preserving field order', async () => {
  setStatus(status('left'));
  setStatus(status('right', { round: 1, safeNextAction: 'inspect' }));
  const forward = await compareCueLineRuns('left', 'right');
  const reverse = await compareCueLineRuns('right', 'left');
  assert.equal(forward.equivalent, false);
  assert.equal(reverse.equivalent, false);
  assert.deepEqual(forward.changes, [
    { field: 'round', left: 0, right: 1 },
    { field: 'safeNextAction', left: 'wait', right: 'inspect' },
  ]);
  assert.deepEqual(reverse.changes, forward.changes.map(({ field, left, right }) =>
    ({ field, left: right, right: left })));
  assert.deepEqual(reverse.left, forward.right);
  assert.deepEqual(reverse.right, forward.left);
});

test('multiple nested and scalar differences have stable alphabetical order', async () => {
  setStatus(status('sort-left'));
  const changed = status('sort-right', {
    safeNextAction: 'inspect', round: 1,
    jobs: { counts: { running: 2, queued: 1 }, total: 3 },
    controller: { pendingTurns: 0, acceptedCommands: 1, archive: { status: 'complete' } },
  });
  setStatus(changed);
  const expected = [
    { field: 'acceptedCommands', left: 0, right: 1 },
    { field: 'archiveStatus', left: 'none', right: 'complete' },
    { field: 'jobs.counts.queued', left: 2, right: 1 },
    { field: 'jobs.counts.running', left: 1, right: 2 },
    { field: 'round', left: 0, right: 1 },
    { field: 'safeNextAction', left: 'wait', right: 'inspect' },
  ];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await compareCueLineRuns('sort-left', 'sort-right');
    assert.equal(result.equivalent, false);
    assert.deepEqual(result.changes, expected);
  }
  // Input key insertion order must not determine report order.
  setStatus({ ...changed, jobs: { total: 3, counts: { queued: 1, running: 2 } } });
  assert.deepEqual((await compareCueLineRuns('sort-left', 'sort-right')).changes, expected);
});

test('run identifiers remain visible but do not affect equivalence', async () => {
  setStatus(status('identity-a'));
  setStatus(status('identity-b'));
  const result = await compareCueLineRuns('identity-a', 'identity-b');
  assert.equal(result.equivalent, true);
  assert.deepEqual(result.changes, []);
  assert.equal(result.left.runId, 'identity-a');
  assert.equal(result.right.runId, 'identity-b');
  const { runId: leftId, ...left } = result.left;
  const { runId: rightId, ...right } = result.right;
  assert.notEqual(leftId, rightId);
  assert.deepEqual(left, right);
});
