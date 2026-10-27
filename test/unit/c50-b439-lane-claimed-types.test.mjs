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

for (const [name, details, retryAllowed] of [
  ['true', { claimed: true }, false],
  ['null', { claimed: null }, false],
  ['zero', { claimed: 0 }, false],
  ['string false', { claimed: 'false' }, false],
  ['missing', {}, false],
  ['boolean false', { claimed: false }, true],
]) {
  test(`HOST_BRIDGE_TIMEOUT with claimed ${name}`, async () => {
    const runId = 'run-claimed-types';
    const records = [];
    let calls = 0;
    const result = await runClaudeDesktopLane({
      mode: { kind: 'resume', runId },
      maxUnclaimedTimeoutRetries: 1,
      startRun: async () => assert.fail('must not create a run'),
      persistedConversationUrl: async () => undefined,
      createBrowser: () => ({}),
      loadStatus: async () => ({ continueAllowed: true, safeNextAction: 'continue' }),
      sleep: async () => assert.fail('ready lane must not sleep'),
      record: async (entry) => { records.push(entry); },
      continueRun: async () => {
        calls += 1;
        if (calls === 1) throw new CueLineError('HOST_BRIDGE_TIMEOUT', 'timeout', { details });
        return { runId, status: 'complete' };
      },
    });
    assert.equal(calls, retryAllowed ? 2 : 1);
    assert.deepEqual(records.filter((entry) => entry.event === 'retrying').map((entry) => entry.retry), retryAllowed ? [1] : []);
    if (retryAllowed) {
      assert.deepEqual(result, { outcome: 'finished', runId, status: { runId, status: 'complete' } });
      assert.equal(records.at(-1).event, 'finished');
    } else {
      assert.deepEqual(result, { outcome: 'stopped', runId, code: 'HOST_BRIDGE_TIMEOUT' });
      assert.equal(records.at(-1).event, 'failed');
      assert.equal(records.at(-1).code, 'HOST_BRIDGE_TIMEOUT');
    }
  });
}
