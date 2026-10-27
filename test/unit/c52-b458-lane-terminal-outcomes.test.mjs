import assert from 'node:assert/strict';
import test from 'node:test';
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
    const result = await runClaudeDesktopLane({
      mode: { kind: 'resume', runId },
      startRun: async () => assert.fail('resume must not create a run'),
      persistedConversationUrl: async () => undefined,
      createBrowser: () => ({}),
      loadStatus: async (id) => { assert.equal(id, runId); loads++; return status; },
      continueRun: async () => { calls++; return { runId, status: 'complete' }; },
      record: async (entry) => { records.push(entry); },
      sleep: async () => { sleeps++; throw new Error('unexpected sleep'); },
    });
    const outcome = phase === 'complete' ? 'finished' : 'stopped';
    assert.deepEqual(result, phase === 'complete'
      ? { outcome, runId, status }
      : { outcome, runId, status, code: phase });
    assert.equal(result.status, status);
    assert.equal(calls, 0);
    assert.equal(loads, 1);
    assert.equal(sleeps, 0);
    assert.deepEqual(records, [
      { event: 'resuming', runId },
      { event: outcome, runId, phase, safeNextAction: status.safeNextAction },
    ]);
    t.diagnostic(`${phase} -> ${result.outcome}; code:${result.code ?? 'none'}; calls:${calls}; loads:${loads}`);
  });
}
