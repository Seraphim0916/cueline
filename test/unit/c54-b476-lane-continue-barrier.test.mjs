import assert from 'node:assert/strict';
import test from 'node:test';
import { CueLineError } from '../../dist/src/core/errors.js';
import { runClaudeDesktopLane } from '../../dist/src/browser/claude-desktop/lane-runner.js';

test('lane awaits continuation before recording progress or loading another round', async (t) => {
  const runId = 'c54-b476';
  const browser = {};
  const records = [];
  const events = [];
  let release;
  let entered;
  const continuation = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const completed = { runId, status: 'complete' };
  let loads = 0;
  let continues = 0;
  let sleeps = 0;
  let recordCalls = 0;
  let settled = false;
  const cap = (name, count, expected) => {
    if (count > expected + 2) {
      throw new CueLineError('TEST_LOOP_OVERFLOW', `${name}: expected ${expected} calls; reached ${count}`);
    }
  };
  const lane = runClaudeDesktopLane({
    mode: { kind: 'resume', runId },
    startRun: async () => assert.fail('resume must not start a run'),
    persistedConversationUrl: async () => undefined,
    createBrowser: () => browser,
    loadStatus: async (id) => {
      cap('loadStatus', ++loads, 1);
      events.push('load');
      assert.equal(id, runId);
      return { continueAllowed: true, phase: 'resume_ready', safeNextAction: 'continue' };
    },
    continueRun: (id, actualBrowser) => {
      cap('continueRun', ++continues, 1);
      events.push('continue');
      entered();
      assert.equal(id, runId);
      assert.strictEqual(actualBrowser, browser);
      return continuation;
    },
    record: async (entry) => {
      cap('record', ++recordCalls, 3);
      records.push(entry);
      events.push(entry.event);
    },
    sleep: async () => { cap('sleep', ++sleeps, 0); throw new Error('unexpected sleep'); },
  });
  // Also unblock the rendezvous if a regression settles before continuation starts.
  void lane.then(() => { settled = true; entered(); }, () => { settled = true; entered(); });
  try {
    await started;
    // Drain queued promise reactions without a timer or releasing continuation.
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    assert.equal(settled, false);
    assert.deepEqual(events, ['resuming', 'load', 'continue']);
    assert.deepEqual(records, [{ event: 'resuming', runId }]);
    assert.deepEqual({ loads, continues, sleeps, recordCalls }, { loads: 1, continues: 1, sleeps: 0, recordCalls: 1 });
    t.diagnostic(`pending:${events.join(',')}`);
  } finally {
    release(completed);
    await lane;
  }
  assert.deepEqual(await lane, { outcome: 'finished', runId, status: completed });
  assert.deepEqual(events, ['resuming', 'load', 'continue', 'progress', 'finished']);
  assert.deepEqual(records, [
    { event: 'resuming', runId },
    { event: 'progress', runId, status: 'complete', result: completed },
    { event: 'finished', runId, status: 'complete', result: completed },
  ]);
  assert.deepEqual({ loads, continues, sleeps, recordCalls }, { loads: 1, continues: 1, sleeps: 0, recordCalls: 3 });
  t.diagnostic(`released:${events.join(',')}; outcome:finished`);
});
