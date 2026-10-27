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

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
// Drain more microtasks than the finite setup path, without timers or wall-clock delays.
const flushMicrotasks = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

for (const continueAllowed of [false, true]) {
  test(`start barriers precede ${continueAllowed ? 'continuation' : 'completed status'}`, async () => {
    const runId = 'run-start-barriers';
    const url = 'https://chatgpt.com/c/barrier-fixture';
    const browser = {};
    const initialRecord = deferred();
    const browserReady = deferred();
    const events = [];
    let settled = false;
    const pending = runClaudeDesktopLane({
      mode: { kind: 'start', request: 'barrier request' },
      startRun: async (request) => {
        assert.equal(request, 'barrier request');
        events.push('start');
        return { runId, status: 'running' };
      },
      record: async (entry) => {
        assert.equal(entry.runId, runId);
        events.push(entry.event);
        if (entry.event === 'created') await initialRecord.promise;
      },
      persistedConversationUrl: async (id) => { assert.equal(id, runId); events.push('url'); return url; },
      createBrowser: (savedUrl) => { assert.equal(savedUrl, url); events.push('browser'); return browserReady.promise; },
      loadStatus: async (id) => {
        assert.equal(id, runId);
        events.push('load');
        return { continueAllowed, phase: continueAllowed ? 'ready' : 'complete', safeNextAction: null };
      },
      continueRun: async (id, actualBrowser) => {
        assert.equal(id, runId);
        assert.equal(actualBrowser, browser);
        events.push('continue');
        return { runId, status: 'complete' };
      },
      sleep: async () => assert.fail('must not sleep'),
    }).then((result) => { settled = true; return result; });
    try {
      await flushMicrotasks();
      assert.deepEqual(events, ['start', 'created']);
      assert.equal(settled, false);
      initialRecord.resolve();
      await flushMicrotasks();
      assert.deepEqual(events, ['start', 'created', 'url', 'browser']);
      assert.equal(settled, false);
      browserReady.resolve(browser);
      const result = await pending;
      assert.equal(result.outcome, 'finished');
      assert.equal(result.runId, runId);
      assert.deepEqual(events, continueAllowed
        ? ['start', 'created', 'url', 'browser', 'load', 'continue', 'progress', 'finished']
        : ['start', 'created', 'url', 'browser', 'load', 'finished']);
    } finally {
      initialRecord.resolve();
      browserReady.resolve(browser);
      await pending;
    }
  });
}
