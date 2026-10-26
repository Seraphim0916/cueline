import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as vm from 'node:vm';

if (!vm.SourceTextModule) {
  test('diff projection with VM modules enabled', () => {
    const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--test', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 30_000 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  });
} else {
  function fixture(runId) {
    return { runId, status: 'running', executor: 'fake', allowProcessExecution: false,
      phase: 'observe', round: 1, maxRounds: null, maxStagnantRounds: 3, stagnantRounds: 0,
      lastEventSequence: 2, runtime: { ownership: 'none' }, cancellation: { runRequested: false },
      controller: { pendingTurns: 0, acceptedCommands: 0, archive: { status: 'none' } },
      jobs: { total: 1, counts: { running: 1 } }, continueAllowed: true, safeNextAction: 'wait' };
  }

  async function compare(left, right) {
    const subject = new vm.SourceTextModule(stripTypeScriptTypes(await readFile(new URL('../../src/observation/run-diff.ts', import.meta.url), 'utf8')));
    const calls = [];
    await subject.link((specifier) => {
      assert.equal(specifier, '../api-runtime-lifecycle.js');
      return new vm.SyntheticModule(['loadCueLineRunStatus'], function () {
        this.setExport('loadCueLineRunStatus', async (id) => {
          calls.push(id);
          assert.ok(id === 'left' || id === 'right');
          return id === 'left' ? left : right;
        });
      });
    });
    await subject.evaluate();
    const result = await subject.namespace.compareCueLineRuns('left', 'right');
    assert.deepEqual(calls, ['left', 'right']);
    return JSON.parse(JSON.stringify(result));
  }

  function addExtras(status, side) {
    for (const [index, container] of [status, status.runtime, status.controller,
      status.controller.archive, status.cancellation, status.jobs].entries()) {
      container[`extra_${side}_${index}`] = `synthetic-${side}-${index}`;
    }
  }

  test('extra fields at every status boundary stay out of both projections and changes', async () => {
    const left = fixture('left');
    const right = fixture('right');
    const baseline = await compare(left, right);
    addExtras(left, 'left');
    addExtras(right, 'right');
    const result = await compare(left, right);
    assert.deepEqual(result, baseline);
    assert.equal(result.equivalent, true);
    assert.deepEqual(result.changes, []);
    const exposed = /extra_|synthetic-/.test(JSON.stringify(result));
    assert.equal(exposed, false);
    console.log(`diff equivalent ${result.equivalent} extra exposed ${exposed}`);
  });

  test('legal job and controller counts remain visible alongside ignored extras', async () => {
    const left = fixture('left');
    const right = fixture('right');
    addExtras(left, 'left');
    addExtras(right, 'right');
    right.controller.pendingTurns = 2;
    right.controller.acceptedCommands = 3;
    right.jobs.total = 3;
    right.jobs.counts.running = 2;
    right.jobs.counts.completed = 1;
    const result = await compare(left, right);
    assert.equal(result.equivalent, false);
    assert.deepEqual(result.changes, [
      { field: 'acceptedCommands', left: 0, right: 3 },
      { field: 'jobs.counts.completed', left: 0, right: 1 },
      { field: 'jobs.counts.running', left: 1, right: 2 },
      { field: 'jobs.total', left: 1, right: 3 },
      { field: 'pendingControllerTurns', left: 0, right: 2 },
    ]);
    assert.deepEqual(result.left.jobs, { total: 1, counts: { running: 1 } });
    assert.deepEqual(result.right.jobs, { total: 3, counts: { running: 2, completed: 1 } });
    assert.equal(/extra_|synthetic-/.test(JSON.stringify(result)), false);
  });
}
