import assert from 'node:assert/strict';
import test from 'node:test';
import { CueLineError } from '../../dist/src/core/errors.js';
import { runClaudeDesktopLane } from '../../dist/src/browser/claude-desktop/lane-runner.js';

test('lane preserves resume diagnostics when status loading fails', async (t) => {
  const runId = 'c52-b457';
  const failure = new CueLineError('STATUS_FAIL', 'Status could not be loaded');
  const records = [];
  let calls = 0;
  let loads = 0;
  let sleeps = 0;
  let recordCalls = 0;
  const cap = (name, count, expected) => {
    if (count > expected + 2) {
      throw new CueLineError('TEST_LOOP_OVERFLOW', `${name}: expected ${expected} calls; reached ${count}`);
    }
  };
  const result = await runClaudeDesktopLane({
    mode: { kind: 'resume', runId },
    startRun: async () => assert.fail('resume must not create a run'),
    persistedConversationUrl: async () => undefined,
    createBrowser: () => ({}),
    loadStatus: async (id) => {
      cap('loadStatus', ++loads, 1);
      assert.equal(id, runId);
      throw failure;
    },
    continueRun: async () => { cap('continueRun', ++calls, 0); return { runId, status: 'complete' }; },
    record: async (entry) => { cap('record', ++recordCalls, 2); records.push(entry); },
    sleep: async () => { cap('sleep', ++sleeps, 0); throw new Error('unexpected sleep'); },
  });
  assert.deepEqual(result, { outcome: 'stopped', runId, code: failure.code });
  assert.equal(calls, 0);
  assert.equal(loads, 1);
  assert.equal(sleeps, 0);
  assert.equal(recordCalls, 2);
  assert.deepEqual(records, [
    { event: 'resuming', runId },
    { event: 'failed', runId, code: failure.code, message: failure.message,
      resume: `cueline-claude-desktop-lane daemon --resume ${runId}` },
  ]);
  t.diagnostic(`${result.outcome} ${result.code}; calls:${calls}; loads:${loads}; events:${JSON.stringify(records.map(({ event }) => event))}`);
});
