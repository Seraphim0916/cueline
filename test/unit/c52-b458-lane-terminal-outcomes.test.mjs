import assert from 'node:assert/strict';
import test from 'node:test';
import { CueLineError } from '../../dist/src/core/errors.js';
import { runClaudeDesktopLane } from '../../dist/src/browser/claude-desktop/lane-runner.js';

const phases = [
  'complete', 'blocked', 'cancelled', 'round_limit_reached',
  'stagnation_detected', 'cancellation_pending', 'runtime_stale',
];

for (const phase of phases) {
  test(`lane summarizes terminal phase ${phase} without continuing`, async (t) => {
    const runId = `c52-b458-${phase}`;
    const status = { continueAllowed: false, phase, safeNextAction: `inspect ${phase}` };
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
      loadStatus: async (id) => { cap('loadStatus', ++loads, 1); assert.equal(id, runId); return status; },
      continueRun: async () => { cap('continueRun', ++calls, 0); return { runId, status: 'complete' }; },
      record: async (entry) => { cap('record', ++recordCalls, 2); records.push(entry); },
      sleep: async () => { cap('sleep', ++sleeps, 0); throw new Error('unexpected sleep'); },
    });
    const outcome = phase === 'complete' ? 'finished' : 'stopped';
    assert.deepEqual(result, phase === 'complete'
      ? { outcome, runId, status }
      : { outcome, runId, status, code: phase });
    assert.equal(result.status, status);
    assert.equal(calls, 0);
    assert.equal(loads, 1);
    assert.equal(sleeps, 0);
    assert.equal(recordCalls, 2);
    assert.deepEqual(records, [
      { event: 'resuming', runId },
      { event: outcome, runId, phase, safeNextAction: status.safeNextAction },
    ]);
    t.diagnostic(`${phase} -> ${result.outcome}; code:${result.code ?? 'none'}; calls:${calls}; loads:${loads}`);
  });
}
