import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as checkpoint } from 'node:timers/promises';
import { waitForCueLineLaneContinuation } from '../../src/browser/claude-desktop/lane-status-guard.ts';

test('notification and sleep must each finish before polling can advance', async () => {
  const notification = Promise.withResolvers();
  const sleeping = Promise.withResolvers();
  const calls = [];
  const waiting = { continueAllowed: false, safeNextAction: 'wait', phase: 'waiting' };
  const ready = { continueAllowed: true, safeNextAction: 'continue' };
  let loads = 0;
  let settled = false;
  const result = waitForCueLineLaneContinuation('ordered-run', {
    async loadStatus(runId) {
      assert.equal(runId, 'ordered-run');
      calls.push('load');
      assert.ok(++loads <= 2, 'no extra polling after continuation');
      return loads === 1 ? waiting : ready;
    },
    async onBlocked(status) {
      assert.equal(status, waiting);
      calls.push('notify');
      await notification.promise;
    },
    async sleep(ms) {
      assert.equal(ms, 17);
      calls.push('sleep');
      await sleeping.promise;
    },
    pollIntervalMs: 17,
  });
  result.then(() => { settled = true; }, () => { settled = true; });
  try {
    // Drain runnable continuations without a clock-based delay.
    await checkpoint();
    assert.deepEqual(calls, ['load', 'notify'], 'notification pending: no sleep');
    assert.equal(settled, false);

    notification.resolve();
    await checkpoint();
    assert.deepEqual(calls, ['load', 'notify', 'sleep'], 'sleep pending: no reload');
    assert.equal(settled, false);

    sleeping.resolve();
    assert.equal(await result, ready, 'return the exact next status');
    assert.deepEqual(calls, ['load', 'notify', 'sleep', 'load']);
  } finally {
    notification.resolve();
    sleeping.resolve();
    await result;
  }
});
