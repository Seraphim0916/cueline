import assert from 'node:assert/strict';
import test from 'node:test';
import { CueLineError } from '../../dist/src/core/errors.js';
import { runClaudeDesktopLane } from '../../dist/src/browser/claude-desktop/lane-runner.js';

test('retry record failure stops an eligible unclaimed timeout retry', async (t) => {
  const runId = 'c52-b456';
  const records = [];
  const browser = {};
  let calls = 0;
  let loads = 0;
  let sleeps = 0;
  let recordCalls = 0;
  const cap = (name, count, expected) => {
    if (count > expected + 2) {
      throw new CueLineError('TEST_LOOP_OVERFLOW', `${name}: expected ${expected} calls; reached ${count}`);
    }
  };
  const failure = new CueLineError('RECORD_RETRY_FAIL', 'Retry record could not be saved');
  const result = await runClaudeDesktopLane({
    mode: { kind: 'resume', runId },
    startRun: async () => assert.fail('resume must not create a run'),
    persistedConversationUrl: async () => undefined,
    createBrowser: () => browser,
    loadStatus: async (id) => {
      cap('loadStatus', ++loads, 1);
      assert.equal(id, runId);
      return { continueAllowed: true, phase: 'resume_ready', safeNextAction: 'continue' };
    },
    continueRun: async (id, actualBrowser) => {
      cap('continueRun', ++calls, 1);
      assert.equal(id, runId);
      assert.equal(actualBrowser, browser);
      if (calls > 1) return { runId, status: 'complete' };
      throw new CueLineError('HOST_BRIDGE_TIMEOUT', 'Unclaimed request timed out', {
        details: { claimed: false },
      });
    },
    record: async (entry) => {
      cap('record', ++recordCalls, 3);
      records.push(entry);
      if (entry.event === 'retrying') throw failure;
    },
    sleep: async () => { cap('sleep', ++sleeps, 0); throw new Error('unexpected sleep'); },
  });
  assert.deepEqual(result, { outcome: 'stopped', runId, code: failure.code });
  assert.equal(calls, 1);
  assert.equal(loads, 1);
  assert.equal(sleeps, 0);
  assert.equal(recordCalls, 3);
  assert.deepEqual(records, [
    { event: 'resuming', runId },
    { event: 'retrying', runId, code: 'HOST_BRIDGE_TIMEOUT', retry: 1 },
    { event: 'failed', runId, code: failure.code, message: failure.message,
      resume: `cueline-claude-desktop-lane daemon --resume ${runId}` },
  ]);
  t.diagnostic(`${result.outcome} ${result.code}; calls:${calls}; loads:${loads}; events:${JSON.stringify(records.map(({ event }) => event))}`);
});
