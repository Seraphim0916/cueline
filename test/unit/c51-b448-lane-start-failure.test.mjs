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

for (const failure of [new Error('creation failed'), new CueLineError('START_FAIL', 'creation failed')]) {
  test(`start failure preserves original ${failure.name} without later operations`, async () => {
    const calls = [];
    const deps = {
      mode: { kind: 'start', request: 'requested task' },
      startRun: async (request) => {
        calls.push(['start', request]);
        throw failure;
      },
    };
    for (const name of ['persistedConversationUrl', 'createBrowser', 'record', 'loadStatus', 'continueRun', 'sleep']) {
      deps[name] = async () => { calls.push([name]); throw new Error(`unexpected ${name}`); };
    }
    await assert.rejects(runClaudeDesktopLane(deps), (error) => {
      assert.strictEqual(error, failure);
      return true;
    });
    assert.deepEqual(calls, [['start', 'requested task']]);
  });
}
