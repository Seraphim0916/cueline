import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const dataUrl = (source) => `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`;
const errors = dataUrl(await readFile(new URL('../../src/core/errors.ts', import.meta.url), 'utf8'));
const source = await readFile(new URL('../../src/observation/run-watch.ts', import.meta.url), 'utf8');
const { waitForCueLineRunChange, setLoader } = await import(dataUrl(source
  .replace(/import .* from "..\/api-runtime-lifecycle.js";/,
    'let loadCueLineRunStatus; export const setLoader = (loader) => { loadCueLineRunStatus = loader; };')
  .replace('"../core/errors.js"', JSON.stringify(errors))));

const cases = [
  ['zero deadline', { status: 'running', lastEventSequence: 0 }, 'timed_out'],
  ['new event', { status: 'running', lastEventSequence: 1 }, 'changed'],
  ['terminal', { status: 'complete', lastEventSequence: 0 }, 'terminal'],
];
for (const [name, status, outcome] of cases) {
  test(`already aborted: ${name}`, async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    setLoader(async () => { calls++; return status; });
    await assert.rejects(waitForCueLineRunChange('run', {
      afterSequence: 0, timeoutMs: 0, signal: controller.signal,
    }), { code: 'RUN_WATCH_ABORTED' });
    assert.equal(calls, 0);
  });
  test(`abort during load: ${name}`, async () => {
    const controller = new AbortController();
    setLoader(async () => { await Promise.resolve(); controller.abort(); return status; });
    await assert.rejects(waitForCueLineRunChange('run', {
      afterSequence: 0, timeoutMs: 0, signal: controller.signal,
    }), { code: 'RUN_WATCH_ABORTED' });
  });
  test(`not aborted: ${name}`, async () => {
    setLoader(async () => status);
    assert.equal((await waitForCueLineRunChange('run', {
      afterSequence: 0, timeoutMs: 0, signal: new AbortController().signal,
    })).outcome, outcome);
  });
}
test('abort during a subsequent load', async () => {
  const controller = new AbortController();
  let calls = 0;
  setLoader(async () => {
    if (++calls === 2) controller.abort();
    return { status: 'running', lastEventSequence: calls === 2 ? 1 : 0 };
  });
  await assert.rejects(waitForCueLineRunChange('run', {
    afterSequence: 0, timeoutMs: 100, pollIntervalMs: 5, signal: controller.signal,
  }), { code: 'RUN_WATCH_ABORTED' });
});
