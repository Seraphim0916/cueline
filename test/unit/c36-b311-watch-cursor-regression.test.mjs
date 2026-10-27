import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { compileFunction } from 'node:vm';

const errors = stripTypeScriptTypes(await readFile(
  new URL('../../src/core/errors.ts', import.meta.url), 'utf8',
));
const { CueLineError } = await import(`data:text/javascript,${encodeURIComponent(errors)}`);
const source = stripTypeScriptTypes(await readFile(
  new URL('../../src/observation/run-watch.ts', import.meta.url), 'utf8',
)).replace(/^import\b[\s\S]*?;\n/gm, '').replace(/^export /gm, '');

for (const secondSequence of [4, 6]) {
  test(`polling sequence 5 -> ${secondSequence} settles immediately`, async (t) => {
    let reads = 0;
    let clock = 1000;
    const waits = [];
    const snapshots = [5, secondSequence].map((lastEventSequence) => ({
      status: 'running', lastEventSequence,
    }));
    const dependencies = {
      CueLineError,
      Date: { now: () => clock },
      delay: async (milliseconds) => {
        waits.push(milliseconds);
        assert.equal(waits.length, 1, 'must not wait again after the second read');
        clock += milliseconds;
      },
      loadCueLineRunStatus: async () => {
        assert.ok(reads < 2, 'must not read again after the second result');
        return snapshots[reads++];
      },
    };
    const watch = compileFunction(`${source}\nreturn waitForCueLineRunChange;`,
      Object.keys(dependencies))(...Object.values(dependencies));
    const result = watch('run', { afterSequence: 5, timeoutMs: 100, pollIntervalMs: 5 });
    if (secondSequence === 4) {
      await assert.rejects(result, (error) => {
        assert.ok(error instanceof CueLineError);
        assert.equal(error.code, 'RUN_WATCH_CURSOR_AHEAD');
        assert.deepEqual(error.details, {
          run_id: 'run', after_sequence: 5, current_sequence: 4,
        });
        return true;
      });
    } else {
      assert.deepEqual(await result, {
        outcome: 'changed', previousSequence: 5, currentSequence: 6,
        elapsedMs: 5, status: snapshots[1],
      });
    }
    assert.equal(reads, 2);
    assert.deepEqual(waits, [5]);
    t.diagnostic(`${secondSequence === 4 ? 'RUN_WATCH_CURSOR_AHEAD' : 'changed'} reads ${reads} waits ${waits.length}`);
  });
}
