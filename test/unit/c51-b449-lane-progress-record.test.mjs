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

test('failed progress record stops a completed continuation without finishing or retrying', async () => {
  const runId = 'run-record-failure';
  const completed = { runId, status: 'complete' };
  const failure = new CueLineError('RECORD_FAIL', 'cannot persist progress');
  const events = [];
  let continues = 0;
  let loads = 0;
  const browser = {};
  const result = await runClaudeDesktopLane({
    mode: { kind: 'resume', runId },
    startRun: async () => assert.fail('must not start'),
    persistedConversationUrl: async () => undefined,
    createBrowser: () => browser,
    loadStatus: async () => {
      loads++;
      return { continueAllowed: true, safeNextAction: 'continue' };
    },
    continueRun: async (id, actualBrowser) => {
      assert.equal(id, runId);
      assert.strictEqual(actualBrowser, browser);
      continues++;
      return completed;
    },
    record: async (entry) => {
      events.push(entry);
      if (entry.event === 'progress') throw failure;
    },
    sleep: async () => assert.fail('must not sleep'),
  });
  assert.deepEqual(result, { outcome: 'stopped', runId, code: 'RECORD_FAIL' });
  assert.equal(continues, 1);
  assert.equal(loads, 1);
  assert.deepEqual(events, [
    { event: 'resuming', runId },
    { event: 'progress', runId, status: 'complete', result: completed },
    { event: 'failed', runId, code: 'RECORD_FAIL', message: failure.message,
      resume: `cueline-claude-desktop-lane daemon --resume ${runId}` },
  ]);
});
