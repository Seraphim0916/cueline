import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { compileFunction } from 'node:vm';

const errors = stripTypeScriptTypes(await readFile(new URL('../../src/core/errors.ts', import.meta.url), 'utf8'));
const { CueLineError } = await import(`data:text/javascript,${encodeURIComponent(errors)}`);
const source = stripTypeScriptTypes(await readFile(new URL('../../src/observation/run-watch.ts', import.meta.url), 'utf8'))
  .replace(/^import\b[\s\S]*?;\n/gm, '').replace(/^export /gm, '');

for (const phase of ['initial', 'polled']) {
  for (const state of ['complete', 'blocked', 'cancelled', 'running']) {
    test(`${phase}: ${state} with a new sequence`, async () => {
      let reads = 0;
      let waits = 0;
      let clock = 0;
      const finalStatus = { status: state, lastEventSequence: 8 };
      const watch = compileFunction(`${source}\nreturn waitForCueLineRunChange;`,
        ['loadCueLineRunStatus', 'CueLineError', 'delay', 'Date'])(
        async () => {
          reads++;
          assert.ok(reads <= 2, 'no extra reads after a decisive observation');
          return phase === 'polled' && reads === 1
            ? { status: 'running', lastEventSequence: 7 } : finalStatus;
        }, CueLineError, async ms => { waits++; clock += ms; }, { now: () => clock },
      );
      const result = await watch('run', { afterSequence: 7, timeoutMs: 100, pollIntervalMs: 5 });
      assert.equal(result.outcome, state === 'running' ? 'changed' : 'terminal');
      assert.strictEqual(result.status, finalStatus);
      assert.equal(result.previousSequence, 7);
      assert.equal(result.currentSequence, 8);
      assert.equal(reads, phase === 'polled' ? 2 : 1);
      assert.equal(waits, phase === 'polled' ? 1 : 0);
    });
  }
}
