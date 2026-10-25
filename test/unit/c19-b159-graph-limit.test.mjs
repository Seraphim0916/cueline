import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const dataUrl = source => `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`;
const errors = dataUrl(await readFile(new URL('../../src/core/errors.ts', import.meta.url), 'utf8'));
const source = stripTypeScriptTypes(await readFile(new URL('../../src/observation/run-graph.ts', import.meta.url), 'utf8'));
const { loadCueLineRunGraph, setLoader } = await import(dataUrl(source
  .replace('"../core/errors.js"', JSON.stringify(errors))
  .replace(/import\s*\{\s*loadCueLineRunTimeline\s*,?\s*\}\s*from "\.\/run-timeline.js";/,
    'let loadCueLineRunTimeline; export const setLoader = loader => { loadCueLineRunTimeline = loader; };')));

for (const limit of [0, 201, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test(`invalid graph limit ${limit} rejects before loading`, async () => {
    let loads = 0;
    setLoader(async () => { loads++; throw new Error('loader must not run'); });
    await assert.rejects(loadCueLineRunGraph('graph-run', { limit }), { code: 'RUN_GRAPH_LIMIT_INVALID' });
    assert.equal(loads, 0);
  });
}

for (const limit of [undefined, 1, 200]) {
  test(`graph limit ${limit ?? 'default'} forwards options unchanged`, async () => {
    const environment = { CUELINE_TEST_MARKER: 'graph-limit' };
    const options = { home: 'unused-test-home', environment, afterSequence: 42 };
    if (limit !== undefined) options.limit = limit;
    const before = { ...options };
    const expectedLimit = limit ?? 100;
    let loads = 0;
    setLoader(async (runId, received) => {
      loads++;
      assert.equal(runId, 'graph-run');
      assert.deepEqual(received, { ...options, limit: expectedLimit });
      assert.equal(received.environment, environment);
      return {
        runId, afterSequence: received.afterSequence, limit: received.limit,
        totalEvents: 42, latestSequence: 42, returnedEvents: 0,
        hasMore: false, nextAfterSequence: 42, entries: [],
      };
    });
    const result = await loadCueLineRunGraph('graph-run', options);
    assert.equal(loads, 1);
    assert.equal(result.limit, expectedLimit);
    assert.equal(result.afterSequence, 42);
    assert.deepEqual(options, before);
  });
}

test('omitting options defaults to limit 100', async () => {
  let loads = 0;
  setLoader(async (runId, options) => {
    loads++;
    assert.equal(runId, 'graph-run');
    assert.deepEqual(options, { limit: 100 });
    return {
      runId, afterSequence: 0, limit: options.limit, totalEvents: 0,
      latestSequence: 0, returnedEvents: 0, hasMore: false,
      nextAfterSequence: 0, entries: [],
    };
  });
  assert.equal((await loadCueLineRunGraph('graph-run')).limit, 100);
  assert.equal(loads, 1);
});
