import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = await readFile(new URL('../../src/browser/claude-desktop/lane-status-guard.ts', import.meta.url), 'utf8');
const { waitForCueLineLaneContinuation } = await import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`);

async function poll(states, pollIntervalMs) {
  const shared = {};
  const notifications = [];
  const sleeps = [];
  let loads = 0;
  const result = await waitForCueLineLaneContinuation('alias-run', {
    async loadStatus(runId) {
      assert.equal(runId, 'alias-run');
      assert.ok(loads < states.length, 'must stop at the final status');
      Object.assign(shared, states[loads++]);
      return shared;
    },
    async onBlocked(status) {
      assert.equal(status, shared);
      notifications.push([status.phase, status.safeNextAction]);
    },
    async sleep(ms) { sleeps.push(ms); },
    pollIntervalMs,
  });
  assert.equal(result, shared);
  assert.equal(loads, states.length);
  return { notifications, sleeps };
}

const waiting = (safeNextAction, phase = 'waiting') => ({ continueAllowed: false, safeNextAction, phase });
const allowed = { continueAllowed: true, safeNextAction: 'continue', phase: 'ready' };

test('reused object reports each action change before continuation', async () => {
  const result = await poll([waiting('first'), waiting('second'), allowed]);
  assert.deepEqual(result.notifications, [['waiting', 'first'], ['waiting', 'second']]);
  assert.deepEqual(result.sleeps, [3000, 3000]);
});

test('reused object reports phase changes and deduplicates unchanged values', async () => {
  const result = await poll([
    waiting('same'), waiting('same'), waiting('same', 'working'),
    waiting('same', 'working'), waiting('same'), allowed,
  ], 17);
  assert.deepEqual(result.notifications, [['waiting', 'same'], ['working', 'same'], ['waiting', 'same']]);
  assert.deepEqual(result.sleeps, [17, 17, 17, 17, 17]);
});

test('action values retain reference-based deduplication', async () => {
  const action = { kind: 'wait' };
  const other = { kind: 'wait' };
  const result = await poll([waiting(action), waiting(action), waiting(other), allowed]);
  assert.equal(result.notifications.length, 2);
  assert.equal(result.notifications[0][1], action);
  assert.equal(result.notifications[1][1], other);
});

for (const phase of ['complete', 'blocked', 'cancelled', 'round_limit_reached', 'stagnation_detected', 'cancellation_pending', 'runtime_stale']) {
  test(`terminal ${phase} returns without notification or extra sleep`, async () => {
    const terminal = waiting('stop', phase);
    assert.deepEqual(await poll([terminal]), { notifications: [], sleeps: [] });
    assert.deepEqual(await poll([waiting('first'), terminal]), {
      notifications: [['waiting', 'first']], sleeps: [3000],
    });
  });
}

test('immediate continuation never notifies or sleeps', async () => {
  assert.deepEqual(await poll([allowed]), { notifications: [], sleeps: [] });
});
