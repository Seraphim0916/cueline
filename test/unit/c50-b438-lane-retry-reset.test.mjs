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

test('successful progress resets the single unclaimed-timeout retry allowance', async () => {
  const runId = 'run-retry-reset';
  const browser = {};
  const records = [];
  let calls = 0;
  const result = await runClaudeDesktopLane({
    mode: { kind: 'resume', runId },
    maxUnclaimedTimeoutRetries: 1,
    startRun: async () => assert.fail('must not create a run'),
    persistedConversationUrl: async () => undefined,
    createBrowser: () => browser,
    loadStatus: async () => ({ continueAllowed: true, safeNextAction: 'continue' }),
    sleep: async () => assert.fail('ready lane must not sleep'),
    record: async (entry) => { records.push(entry); },
    continueRun: async (id, actualBrowser) => {
      assert.equal(id, runId);
      assert.equal(actualBrowser, browser);
      calls += 1;
      assert.ok(calls <= 4, 'unexpected extra continuation');
      if (calls === 1 || calls === 3) {
        throw new CueLineError('HOST_BRIDGE_TIMEOUT', 'unclaimed', { details: { claimed: false } });
      }
      return { runId, status: calls === 2 ? 'awaiting_controller' : 'complete' };
    },
  });
  assert.deepEqual(result, { outcome: 'finished', runId, status: { runId, status: 'complete' } });
  assert.equal(calls, 4);
  assert.deepEqual(records.filter((entry) => entry.event === 'retrying').map((entry) => entry.retry), [1, 1]);
  assert.deepEqual(records.map((entry) => entry.event), ['resuming', 'retrying', 'progress', 'retrying', 'progress', 'finished']);
});
