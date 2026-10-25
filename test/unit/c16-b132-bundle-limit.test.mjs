import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { compileFunction } from 'node:vm';

const errors = await readFile(new URL('../../src/core/errors.ts', import.meta.url), 'utf8');
const { CueLineError } = await import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(errors))}`);
const source = stripTypeScriptTypes(await readFile(
  new URL('../../src/observation/run-bundle.ts', import.meta.url), 'utf8',
)).replace(/^import\b[\s\S]*?;\n/gm, '').replace(/^export /gm, '');

function fixture() {
  const calls = { status: [], verification: [], timeline: [] };
  const status = { status: 'complete' };
  const verification = { ok: true };
  const timeline = { entries: [] };
  const dependencies = {
    CueLineError,
    loadCueLineRunStatus: async (...args) => { calls.status.push(args); return status; },
    verifyCueLineRun: async (...args) => { calls.verification.push(args); return verification; },
    loadCueLineRunTimeline: async (...args) => { calls.timeline.push(args); return timeline; },
    safeCueLineRunStatus: () => ({ status: 'complete' }),
    diagnoseCueLineRunStatus: () => ({ issues: [] }),
    runtimeEnvironment: () => { assert.fail('must use the fixture environment'); },
    defaultCueLineHome: () => { assert.fail('must use the fixture home'); },
    CUELINE_VERSION: 'fixture-version',
  };
  const build = compileFunction(`${source}\nreturn buildCueLineRunSupportBundle;`,
    Object.keys(dependencies))(...Object.values(dependencies));
  return { build, calls, verification, timeline };
}

const options = { home: '/fixture/unused', environment: {}, now: () => new Date('2026-01-01T00:00:00Z') };

for (const timelineLimit of [1, 1000]) {
  test(`public builder accepts timelineLimit=${timelineLimit}`, async () => {
    const f = fixture();
    const result = await f.build('fixture-run', { ...options, timelineLimit });
    for (const calls of Object.values(f.calls)) {
      assert.equal(calls.length, 1);
      assert.equal(calls[0][0], 'fixture-run');
    }
    assert.equal(f.calls.timeline[0][1].limit, timelineLimit);
    assert.strictEqual(result.timeline, f.timeline);
    assert.strictEqual(result.verification, f.verification);
    assert.equal(result.schema, 'cueline-run-export/1');
  });
}

for (const timelineLimit of [0, 1001, 1.5, NaN, Infinity, -Infinity]) {
  test(`public builder rejects timelineLimit=${timelineLimit} before all loaders`, async () => {
    const f = fixture();
    await assert.rejects(f.build('fixture-run', { ...options, timelineLimit }),
      { code: 'RUN_BUNDLE_LIMIT_INVALID' });
    assert.deepEqual(f.calls, { status: [], verification: [], timeline: [] });
  });
}
