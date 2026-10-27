import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { compileFunction } from 'node:vm';

const source = stripTypeScriptTypes(await readFile(new URL('../../src/observation/run-diff.ts', import.meta.url), 'utf8'))
  .replace(/^import\b[\s\S]*?;\n/gm, '').replace(/^export /gm, '');
const makeCompare = compileFunction(`${source}\nreturn compareCueLineRuns;`, ['loadCueLineRunStatus']);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function status(runId, onRead) {
  return new Proxy({ runId, status: 'running', executor: 'fake', allowProcessExecution: false,
    phase: 'observe', round: 0, maxRounds: null, maxStagnantRounds: 3, stagnantRounds: 0,
    lastEventSequence: 0, runtime: { ownership: 'none' }, cancellation: { runRequested: false },
    controller: { pendingTurns: 0, acceptedCommands: 0, archive: { status: 'none' } },
    jobs: { total: 0, counts: {} }, continueAllowed: true, safeNextAction: 'wait',
  }, { get(target, key, receiver) {
    // Promise resolution probes "then"; that is not a projection read.
    if (key !== 'then') onRead();
    return Reflect.get(target, key, receiver);
  } });
}

for (const failedSide of ['left', 'right']) {
  for (const timing of ['immediate', 'delayed']) {
    test(`${failedSide} ${timing} failure preserves error and prevents projection`, async () => {
      const failure = new Error(`${failedSide} load failed`);
      const gate = deferred();
      const calls = [];
      let projectionReads = 0;
      const compare = makeCompare(async id => {
        calls.push(id);
        if (id === failedSide) {
          if (timing === 'delayed') return gate.promise;
          throw failure;
        }
        return status(id, () => projectionReads++);
      });
      const pending = compare('left', 'right');
      const rejection = assert.rejects(pending, error => { assert.strictEqual(error, failure); return true; });
      assert.deepEqual(calls, ['left', 'right'], 'both loads start before either is awaited');
      if (timing === 'delayed') {
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(projectionReads, 0, 'successful side must wait for the other load');
        gate.reject(failure);
      }
      await rejection;
      assert.equal(projectionReads, 0);
      assert.deepEqual(calls, ['left', 'right'], 'no retry');
    });
  }
}

for (const first of ['left', 'right']) {
  test(`successful loads project only after both resolve (${first} first)`, async () => {
    const gates = { left: deferred(), right: deferred() };
    const calls = [];
    const reads = { left: 0, right: 0 };
    const compare = makeCompare(id => { calls.push(id); return gates[id].promise; });
    const pending = compare('left', 'right');
    assert.deepEqual(calls, ['left', 'right']);
    gates[first].resolve(status(first, () => reads[first]++));
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(reads, { left: 0, right: 0 });
    const second = first === 'left' ? 'right' : 'left';
    gates[second].resolve(status(second, () => reads[second]++));
    const result = await pending;
    assert.ok(reads.left > 0 && reads.right > 0, 'projection tracking detects actual successful projection');
    assert.equal(result.equivalent, true);
    assert.deepEqual(result.changes, []);
    assert.equal(result.left.runId, 'left');
    assert.equal(result.right.runId, 'right');
  });
}
