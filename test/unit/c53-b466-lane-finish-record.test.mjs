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

for (const alreadyComplete of [true, false]) {
  test(`${alreadyComplete ? 'loaded status' : 'continuation result'} complete: finished record failure stops`, async () => {
    const runId = 'run-finish-record';
    const browser = {};
    const records = [];
    let loads = 0;
    let continuations = 0;
    const failure = new CueLineError('FINISH_RECORD_FAIL', 'finished record unavailable');
    const result = await runClaudeDesktopLane({
      mode: { kind: 'resume', runId },
      startRun: async () => assert.fail('must not start'),
      persistedConversationUrl: async (id) => { assert.equal(id, runId); return undefined; },
      createBrowser: () => browser,
      loadStatus: async (id) => {
        assert.equal(id, runId);
        assert.equal(++loads, 1, 'must not reload after finished record failure');
        return { continueAllowed: !alreadyComplete, phase: alreadyComplete ? 'complete' : 'ready', safeNextAction: null };
      },
      continueRun: async (id, actualBrowser) => {
        assert.equal(id, runId);
        assert.equal(actualBrowser, browser);
        assert.equal(++continuations, 1, 'must not continue again');
        return { runId, status: 'complete' };
      },
      sleep: async () => assert.fail('must not sleep'),
      record: async (entry) => {
        records.push(entry);
        if (entry.event === 'finished') throw failure;
      },
    });
    assert.deepEqual(result, { outcome: 'stopped', runId, code: 'FINISH_RECORD_FAIL' });
    assert.equal(loads, 1);
    assert.equal(continuations, alreadyComplete ? 0 : 1);
    assert.deepEqual(records.map(({ event }) => event), alreadyComplete
      ? ['resuming', 'finished', 'failed']
      : ['resuming', 'progress', 'finished', 'failed']);
    assert.ok(records.every((entry) => entry.runId === runId));
    assert.deepEqual(records.at(-1), {
      event: 'failed', runId, code: 'FINISH_RECORD_FAIL', message: failure.message,
      resume: `cueline-claude-desktop-lane daemon --resume ${runId}`,
    });
  });
}
