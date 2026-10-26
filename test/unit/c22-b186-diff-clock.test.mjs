import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = await readFile(new URL('../../src/observation/run-diff.ts', import.meta.url), 'utf8');
// Only the loader is substituted: comparison and observation-clock logic are original.
const compiled = stripTypeScriptTypes(source).replace(
  'import { loadCueLineRunStatus } from "../api-runtime-lifecycle.js";',
  'let loadCueLineRunStatus; export const setLoader = loader => { loadCueLineRunStatus = loader; };');
const { compareCueLineRuns, setLoader } = await import(`data:text/javascript,${encodeURIComponent(compiled)}`);

function status(runId) {
  return { runId, status: 'running', executor: 'fake', allowProcessExecution: false,
    phase: 'observe', round: 0, maxRounds: null, maxStagnantRounds: 3, stagnantRounds: 0,
    lastEventSequence: 0, runtime: { ownership: 'none' }, cancellation: { runRequested: false },
    controller: { pendingTurns: 0, acceptedCommands: 0, archive: { status: 'none' } },
    jobs: { total: 0, counts: {} }, continueAllowed: true, safeNextAction: 'wait' };
}

test('default loaders share one clock function and one observation instant', async () => {
  const calls = [];
  setLoader(async (id, options) => {
    calls.push({ id, now: options.now, instant: options.now() });
    return status(id);
  });
  const result = await compareCueLineRuns('left', 'right');
  assert.deepEqual(calls.map(call => call.id), ['left', 'right']);
  assert.equal(typeof calls[0].now, 'function');
  assert.strictEqual(calls[0].now, calls[1].now);
  assert.ok(calls[0].instant instanceof Date);
  assert.ok(Number.isFinite(calls[0].instant.getTime()));
  assert.strictEqual(calls[0].instant, calls[1].instant);
  assert.strictEqual(calls[0].now(), calls[0].instant, 'repeated reads retain the captured instant');
  assert.strictEqual(calls[1].now(), calls[0].instant);
  assert.equal(result.equivalent, true);
});

test('explicit now is forwarded unchanged to both loaders without freezing it', async () => {
  let ticks = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1) + ticks++);
  const calls = [];
  setLoader(async (id, options) => {
    calls.push({ id, now: options.now, instant: options.now() });
    return status(id);
  });
  await compareCueLineRuns('left', 'right', { now });
  assert.deepEqual(calls.map(call => call.id), ['left', 'right']);
  for (const call of calls) assert.strictEqual(call.now, now);
  assert.equal(ticks, 2, 'comparison must not eagerly invoke the supplied clock');
  assert.equal(calls[1].instant.getTime() - calls[0].instant.getTime(), 1);
});
