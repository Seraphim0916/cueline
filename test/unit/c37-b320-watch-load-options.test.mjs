import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { compileFunction } from 'node:vm';

const errors = stripTypeScriptTypes(await readFile(new URL('../../src/core/errors.ts', import.meta.url), 'utf8'));
const { CueLineError } = await import(`data:text/javascript,${encodeURIComponent(errors)}`);
const source = stripTypeScriptTypes(await readFile(new URL('../../src/observation/run-watch.ts', import.meta.url), 'utf8'))
  .replace(/^import\b[\s\S]*?;\n/gm, '').replace(/^export /gm, '');

for (let mask = 0; mask < 8; mask++) {
  for (const absent of ['omitted', 'undefined']) {
    test(`load options subset ${mask}, absent fields ${absent}, across three reads`, async () => {
      const values = { home: tmpdir(), environment: Object.freeze({ CUELINE_TEST: 'identity' }), now: () => new Date(0) };
      const supplied = {};
      const expected = {};
      Object.entries(values).forEach(([key, value], index) => {
        if (mask & (1 << index)) supplied[key] = expected[key] = value;
        else if (absent === 'undefined') supplied[key] = undefined;
      });
      const calls = [];
      let clock = 0;
      let waits = 0;
      const watch = compileFunction(`${source}\nreturn waitForCueLineRunChange;`,
        ['loadCueLineRunStatus', 'CueLineError', 'delay', 'Date'])(
        async (id, options) => {
          calls.push({ id, options });
          assert.ok(calls.length <= 3);
          return { status: 'running', lastEventSequence: calls.length === 3 ? 1 : 0 };
        }, CueLineError, async ms => { waits++; clock += ms; }, { now: () => clock },
      );
      const result = await watch('run', { ...supplied, afterSequence: 0, timeoutMs: 100,
        pollIntervalMs: 5, signal: new AbortController().signal });
      assert.equal(result.outcome, 'changed');
      assert.equal(calls.length, 3);
      assert.equal(waits, 2);
      for (const { id, options } of calls) {
        assert.equal(id, 'run');
        assert.deepEqual(Object.keys(options).sort(), Object.keys(expected).sort(), 'only supplied load options are present');
        for (const [key, value] of Object.entries(expected)) assert.strictEqual(options[key], value);
      }
    });
  }
}
