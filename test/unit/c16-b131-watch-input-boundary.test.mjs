import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { compileFunction } from 'node:vm';

const errors = await readFile(new URL('../../src/core/errors.ts', import.meta.url), 'utf8');
const { CueLineError } = await import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(errors))}`);
const source = stripTypeScriptTypes(await readFile(
  new URL('../../src/observation/run-watch.ts', import.meta.url), 'utf8',
)).replace(/^import\b[\s\S]*?;\n/gm, '').replace(/^export /gm, '');

function fixture(sequence = 0) {
  let loads = 0;
  const status = { status: 'complete', lastEventSequence: sequence };
  const watch = compileFunction(`${source}\nreturn waitForCueLineRunChange;`,
    ['loadCueLineRunStatus', 'CueLineError', 'delay'])(
    async () => { loads++; return status; }, CueLineError,
    () => { assert.fail('legal endpoints must return without polling'); },
  );
  return { watch, status, loads: () => loads };
}

for (const [option, values] of [
  ['afterSequence', [0, Number.MAX_SAFE_INTEGER]],
  ['timeoutMs', [0, 30000]],
  ['pollIntervalMs', [5, 1000]],
]) {
  for (const value of values) {
    test(`accepts ${option}=${value} without waiting`, async () => {
      const f = fixture(option === 'afterSequence' ? value : 0);
      const result = await f.watch('fixture-run', { afterSequence: 0, [option]: value });
      assert.equal(result.outcome, 'terminal');
      assert.strictEqual(result.status, f.status);
      assert.equal(result.previousSequence, option === 'afterSequence' ? value : 0);
      assert.equal(f.loads(), 1);
    });
  }
}

for (const [option, bounds] of [
  ['afterSequence', [-1, Number.MAX_SAFE_INTEGER + 1]],
  ['timeoutMs', [-1, 30001, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]],
  ['pollIntervalMs', [4, 1001, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]],
]) {
  for (const value of [...bounds, 5.5, NaN, Infinity, -Infinity]) {
    test(`rejects ${option}=${value} before status loading`, async () => {
      const f = fixture();
      await assert.rejects(f.watch('fixture-run', { afterSequence: 0, [option]: value }),
        (error) => {
          assert.equal(error.code, 'RUN_WATCH_OPTIONS_INVALID');
          assert.equal(error.details.option, option);
          return true;
        });
      assert.equal(f.loads(), 0);
    });
  }
}
