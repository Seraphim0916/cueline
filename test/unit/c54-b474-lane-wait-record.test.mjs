import assert from 'node:assert/strict';
import test from 'node:test';
import { CueLineError } from '../../dist/src/core/errors.js';
import { runClaudeDesktopLane } from '../../dist/src/browser/claude-desktop/lane-runner.js';

test('waiting record failure stops the entire lane with resume diagnostics', async (t) => {
  const runId = 'c54-b474';
  const failure = new CueLineError('WAIT_RECORD_FAIL', 'Waiting record could not be saved');
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
  const blocked = { continueAllowed: false, phase: 'running', safeNextAction: 'wait' };
  const result = await runClaudeDesktopLane({
    mode: { kind: 'resume', runId },
    startRun: async () => assert.fail('resume must not start a run'),
    persistedConversationUrl: async () => undefined,
    createBrowser: () => ({}),
    loadStatus: async (id) => {
      cap('loadStatus', ++loads, 1);
      assert.equal(id, runId);
      return blocked;
    },
    continueRun: async () => { cap('continueRun', ++continues, 0); return { runId, status: 'complete' }; },
    sleep: async () => { cap('sleep', ++sleeps, 0); throw new Error('unexpected sleep'); },
    record: async (entry) => {
      cap('record', ++recordCalls, 3);
      records.push(entry);
      if (entry.event === 'waiting') throw failure;
    },
  });
  assert.deepEqual(result, { outcome: 'stopped', runId, code: failure.code });
  assert.deepEqual({ loads, sleeps, continues, recordCalls }, { loads: 1, sleeps: 0, continues: 0, recordCalls: 3 });
  assert.deepEqual(records, [
    { event: 'resuming', runId },
    { event: 'waiting', runId, phase: blocked.phase, safeNextAction: blocked.safeNextAction },
    { event: 'failed', runId, code: failure.code, message: failure.message,
      resume: `cueline-claude-desktop-lane daemon --resume ${runId}` },
  ]);
  t.diagnostic(`${result.outcome} ${result.code}; loads:${loads}, sleeps:${sleeps}, continues:${continues}; events:${records.map(({ event }) => event).join(',')}`);
});
