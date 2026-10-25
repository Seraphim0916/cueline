import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { stripTypeScriptTypes } from 'node:module';

const source = await readFile(new URL('../../src/observation/run-diff.ts', import.meta.url), 'utf8');
const compiled = stripTypeScriptTypes(source);
const { compareCueLineRuns } = await import(`data:text/javascript,${encodeURIComponent(compiled.replace(/import .* from "..\/api-runtime-lifecycle.js";/, 'const loadCueLineRunStatus = async (id) => JSON.parse(id);'))}`);

function status(maxRounds, counts = {}) {
  return JSON.stringify({ runId: 'run', status: 'running', executor: 'fake', allowProcessExecution: false,
    phase: 'observe', round: 0, maxRounds, maxStagnantRounds: 3, stagnantRounds: 0,
    lastEventSequence: 0, runtime: { ownership: 'none' }, cancellation: { runRequested: false },
    controller: { pendingTurns: 0, acceptedCommands: 0, archive: { status: 'none' } },
    jobs: { total: 0, counts }, continueAllowed: true, safeNextAction: 'wait' });
}

for (const [left, right] of [[null, 5], [5, null], [null, null]]) {
  test(`maxRounds ${left} -> ${right}`, async () => {
    const result = await compareCueLineRuns(status(left), status(right));
    assert.deepEqual(result.changes, left === right ? [] : [{ field: 'maxRounds', left, right }]);
    assert.equal(result.equivalent, left === right);
  });
}
test('missing job counts equal zero in both directions', async () => {
  for (const [left, right] of [[{}, { queued: 0 }], [{ queued: 0 }, {}]]) {
    assert.deepEqual((await compareCueLineRuns(status(null, left), status(null, right))).changes, []);
  }
  assert.deepEqual((await compareCueLineRuns(status(null), status(null, { queued: 2 }))).changes,
    [{ field: 'jobs.counts.queued', left: 0, right: 2 }]);
});
