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

for (const stage of ['persistedConversationUrl', 'createBrowser']) {
  test(`resume preserves identity and failure record when ${stage} fails`, async () => {
    const runId = 'run-existing-setup-failure';
    const url = 'https://chatgpt.com/c/existing-fixture';
    const failure = new CueLineError('FIXTURE_SETUP', `${stage} failed`);
    const records = [];
    const calls = { start: 0, url: 0, browser: 0, status: 0, continue: 0, sleep: 0 };
    const result = await runClaudeDesktopLane({
      mode: { kind: 'resume', runId },
      startRun: async () => { calls.start += 1; assert.fail('must not create a run'); },
      persistedConversationUrl: async (id) => {
        calls.url += 1;
        assert.equal(id, runId);
        if (stage === 'persistedConversationUrl') throw failure;
        return url;
      },
      createBrowser: async (savedUrl) => {
        calls.browser += 1;
        assert.equal(savedUrl, url);
        throw failure;
      },
      loadStatus: async () => { calls.status += 1; assert.fail('must not load status'); },
      continueRun: async () => { calls.continue += 1; assert.fail('must not continue'); },
      sleep: async () => { calls.sleep += 1; assert.fail('must not sleep'); },
      record: async (entry) => { records.push(entry); },
    });
    assert.deepEqual(result, { outcome: 'stopped', runId, code: 'FIXTURE_SETUP' });
    assert.deepEqual(calls, { start: 0, url: 1, browser: stage === 'createBrowser' ? 1 : 0, status: 0, continue: 0, sleep: 0 });
    assert.deepEqual(records, [
      { event: 'resuming', runId },
      { event: 'failed', runId, code: 'FIXTURE_SETUP', message: failure.message,
        resume: `cueline-claude-desktop-lane daemon --resume ${runId}` },
    ]);
  });
}
