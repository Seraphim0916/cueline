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
  const result = await runClaudeDesktopLane({
    mode: { kind: 'resume', runId },
    startRun: async () => assert.fail('resume must not create a run'),
    persistedConversationUrl: async () => undefined,
    createBrowser: () => ({}),
    loadStatus: async (id) => {
      assert.equal(id, runId);
      loads++;
      throw failure;
    },
    continueRun: async () => { calls++; return { runId, status: 'complete' }; },
    record: async (entry) => { records.push(entry); },
    sleep: async () => { sleeps++; throw new Error('unexpected sleep'); },
  });
  assert.deepEqual(result, { outcome: 'stopped', runId, code: failure.code });
  assert.equal(calls, 0);
  assert.equal(loads, 1);
  assert.equal(sleeps, 0);
  assert.deepEqual(records, [
    { event: 'resuming', runId },
    { event: 'failed', runId, code: failure.code, message: failure.message,
      resume: `cueline-claude-desktop-lane daemon --resume ${runId}` },
  ]);
  t.diagnostic(`${result.outcome} ${result.code}; calls:${calls}; loads:${loads}; events:${JSON.stringify(records.map(({ event }) => event))}`);
});
