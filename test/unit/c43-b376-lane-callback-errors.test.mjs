import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as checkpoint } from 'node:timers/promises';
import { waitForCueLineLaneContinuation } from '../../dist/src/browser/claude-desktop/lane-status-guard.js';

for (const [failureAt, expected] of [
  ['load', ['load']],
  ['notify', ['load', 'notify']],
  ['sleep', ['load', 'notify', 'sleep']],
]) {
  test(`${failureAt} rejection preserves the original error and stops polling`, async () => {
    const failure = new Error(`${failureAt} failed`, { cause: new Error('original cause') });
    const calls = [];
    const waiting = { continueAllowed: false, safeNextAction: 'wait', phase: 'waiting' };
    let loads = 0;
    const result = waitForCueLineLaneContinuation('failure-run', {
      async loadStatus(runId) {
        calls.push('load');
        assert.equal(runId, 'failure-run');
        assert.equal(++loads, 1, 'a callback failure must never trigger a retry');
        if (failureAt === 'load') throw failure;
        return waiting;
      },
      async onBlocked(status) {
        calls.push('notify');
        assert.equal(status, waiting);
        if (failureAt === 'notify') throw failure;
      },
      async sleep(ms) {
        calls.push('sleep');
        assert.equal(ms, 3000);
        if (failureAt === 'sleep') throw failure;
      },
    });
    await assert.rejects(result, (error) => {
      assert.equal(error, failure, 'preserve object identity, including its cause');
      return true;
    });
    assert.deepEqual(calls, expected, 'stop at the failing callback');
    await checkpoint();
    assert.deepEqual(calls, expected, 'no detached continuation after rejection');
  });
}
