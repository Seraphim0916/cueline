import assert from 'node:assert/strict';
import test from 'node:test';
import { CueLineError } from '../../dist/src/core/errors.js';
import { runClaudeDesktopLane } from '../../dist/src/browser/claude-desktop/lane-runner.js';

test('failed record rejection escapes unchanged instead of settling the lane', async (t) => {
  const runId = 'c54-b475';
  const originalFailure = new CueLineError('STATUS_FAIL', 'Status could not be loaded');
  const saveFailure = new Error('Failed record could not be saved');
  const records = [];
  let loads = 0;
  let sleeps = 0;
  let continues = 0;
  let recordCalls = 0;
  const cap = (name, count, expected) => {
    if (count > expected + 2) {
      throw new CueLineError('TEST_LOOP_OVERFLOW', `${name}: expected ${expected} calls; reached ${count}`);
    }
  };
  await assert.rejects(runClaudeDesktopLane({
    mode: { kind: 'resume', runId },
    startRun: async () => assert.fail('resume must not start a run'),
    persistedConversationUrl: async () => undefined,
    createBrowser: () => ({}),
    loadStatus: async (id) => {
      cap('loadStatus', ++loads, 1);
      assert.equal(id, runId);
      throw originalFailure;
    },
    continueRun: async () => { cap('continueRun', ++continues, 0); return { runId, status: 'complete' }; },
    sleep: async () => { cap('sleep', ++sleeps, 0); throw new Error('unexpected sleep'); },
    record: async (entry) => {
      cap('record', ++recordCalls, 2);
      records.push(entry);
      if (entry.event === 'failed') throw saveFailure;
    },
  }), (error) => {
    assert.strictEqual(error, saveFailure);
    return true;
  });
  assert.deepEqual({ loads, sleeps, continues, recordCalls }, { loads: 1, sleeps: 0, continues: 0, recordCalls: 2 });
  assert.deepEqual(records, [
    { event: 'resuming', runId },
    { event: 'failed', runId, code: originalFailure.code, message: originalFailure.message,
      resume: `cueline-claude-desktop-lane daemon --resume ${runId}` },
  ]);
  t.diagnostic(`same_error true; events:${JSON.stringify(records.map(({ event }) => event))}`);
});
