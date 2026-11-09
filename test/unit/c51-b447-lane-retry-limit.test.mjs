import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const dataUrl = (source) => `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`;
const errors = dataUrl(await readFile(new URL('../../src/core/errors.ts', import.meta.url), 'utf8'));
const guard = dataUrl(await readFile(new URL('../../src/browser/claude-desktop/lane-status-guard.ts', import.meta.url), 'utf8'));
const source = await readFile(new URL('../../src/browser/claude-desktop/lane-runner.ts', import.meta.url), 'utf8');
const { runClaudeDesktopLane } = await import(dataUrl(source
  .replace('"../../core/errors.js"', JSON.stringify(errors))
  .replace('"./lane-status-guard.js"', JSON.stringify(guard))));
const { CueLineError } = await import(errors);

for (const mode of [{ kind: 'start', request: 'task' }, { kind: 'resume', runId: 'existing' }]) {
  for (const limit of [NaN, Infinity, -Infinity, 1.5, -0.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
    test(`${mode.kind}: rejects ${limit} before any callback`, async () => {
      const calls = [];
      const deps = { mode, maxUnclaimedTimeoutRetries: limit };
      for (const name of ['startRun', 'continueRun', 'loadStatus', 'persistedConversationUrl', 'createBrowser', 'record', 'sleep']) {
        deps[name] = async () => {
          calls.push(name);
          throw new Error(`unexpected ${name}`);
        };
      }
      await assert.rejects(runClaudeDesktopLane(deps), { code: 'INVALID_RETRY_LIMIT' });
      assert.deepEqual(calls, []);
    });
  }
}

function harness(limit, failure, expectedCalls = 1) {
  let calls = 0;
  const events = [];
  const deps = {
    mode: { kind: 'resume', runId: 'existing' },
    ...(limit === undefined ? {} : { maxUnclaimedTimeoutRetries: limit }),
    startRun: async () => assert.fail('must not start'),
    continueRun: async () => {
      calls++;
      // Bound the fake independently of the runner's retry-limit implementation.
      if (calls > expectedCalls + 2) {
        throw new CueLineError('TEST_RETRY_OVERFLOW', `Expected ${expectedCalls} continueRun calls; reached ${calls}`);
      }
      throw failure;
    },
    loadStatus: async () => ({ continueAllowed: true, safeNextAction: 'continue' }),
    persistedConversationUrl: async () => undefined,
    createBrowser: () => ({}),
    record: async (entry) => { events.push(entry); },
    sleep: async () => assert.fail('must not sleep'),
  };
  return { deps, events, calls: () => calls };
}

for (const [limit, expected] of [[undefined, 4], [0, 1], [2, 3]]) {
  test(`safe timeout retry budget ${limit ?? 'default'}`, async () => {
    const h = harness(limit, new CueLineError('HOST_BRIDGE_TIMEOUT', 'timeout', { details: { claimed: false } }), expected);
    const result = await runClaudeDesktopLane(h.deps);
    assert.equal(h.calls(), expected, `retry budget ${limit ?? 'default'}: expected exactly ${expected} continueRun calls; got ${h.calls()}`);
    assert.deepEqual(result, { outcome: 'stopped', runId: 'existing', code: 'HOST_BRIDGE_TIMEOUT' });
    assert.deepEqual(h.events.filter((entry) => entry.event === 'retrying').map((entry) => entry.retry),
      Array.from({ length: expected - 1 }, (_, index) => index + 1));
  });
}

for (const [code, details] of [
  ['HOST_BRIDGE_TIMEOUT', { claimed: true }],
  ['HOST_BRIDGE_TIMEOUT', undefined],
  ['HOST_BRIDGE_TIMEOUT', { claimed: 'false' }],
  ['HOST_BRIDGE_ACTION_OUTCOME_UNKNOWN', { claimed: false }],
]) {
  test(`unsafe failure is not retried: ${code} ${JSON.stringify(details)}`, async () => {
    const h = harness(undefined, new CueLineError(code, 'failure', { details }));
    assert.equal((await runClaudeDesktopLane(h.deps)).code, code);
    assert.equal(h.calls(), 1);
    assert.equal(h.events.some((entry) => entry.event === 'retrying'), false);
  });
}

test('maximum safe integer is accepted without consuming its budget', async () => {
  const h = harness(Number.MAX_SAFE_INTEGER, new Error('unused'));
  h.deps.continueRun = async () => ({ runId: 'existing', status: 'complete' });
  assert.equal((await runClaudeDesktopLane(h.deps)).outcome, 'finished');
});
