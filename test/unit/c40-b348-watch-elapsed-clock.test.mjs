import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = stripTypeScriptTypes(await readFile(
  new URL('../../src/observation/run-watch.ts', import.meta.url), 'utf8',
));
const errors = stripTypeScriptTypes(await readFile(
  new URL('../../src/core/errors.ts', import.meta.url), 'utf8',
));
const errorsUrl = `data:text/javascript,${encodeURIComponent(errors)}`;
let moduleId = 0;

// Keep the source exports intact; substitute only dependencies, as in c5-run-watch-abort.
async function createWatch(loader, sleep, clock) {
  const compiled = source
    .replace('import { loadCueLineRunStatus } from "../api-runtime-lifecycle.js";',
      'let loadCueLineRunStatus;')
    .replace('import { setTimeout as delay } from "node:timers/promises";', 'let delay;')
    .replace('"../core/errors.js"', JSON.stringify(errorsUrl));
  const module = await import(`data:text/javascript,${encodeURIComponent(
    compiled + '\nlet Date; export function setDependencies(loader, sleep, clock) {'
      + ' loadCueLineRunStatus = loader; delay = sleep; Date = clock; }',
  )}#${moduleId++}`);
  assert.equal(typeof module.waitForCueLineRunChange, 'function', 'watch must remain exported');
  module.setDependencies(loader, sleep, clock);
  return module.waitForCueLineRunChange;
}

for (const outcome of ['terminal', 'changed', 'timed_out']) {
  for (const [endedAt, expectedElapsed] of [[90, 0], [100, 0], [103, 3]]) {
    test(`${outcome}: clock 100 -> ${endedAt} reports elapsed ${expectedElapsed}`, async () => {
      // For timeout, first reach the deadline; then move the clock at result creation.
      const times = outcome === 'timed_out' ? [100, 100, endedAt] : [100, endedAt];
      let clockReads = 0;
      let loads = 0;
      const status = {
        status: outcome === 'terminal' ? 'complete' : 'running',
        lastEventSequence: outcome === 'timed_out' ? 7 : 8,
      };
      const watch = await createWatch(
        async () => { loads++; return status; },
        async () => { assert.fail('immediate results must not wait'); },
        { now: () => {
          assert.ok(clockReads < times.length, 'unexpected clock read');
          return times[clockReads++];
        } },
      );
      const result = await watch('elapsed-clock-run', {
        afterSequence: 7, timeoutMs: 0, pollIntervalMs: 5,
      });
      assert.equal(result.elapsedMs, expectedElapsed);
      // Terminal wins over a new event; both win over the zero timeout.
      assert.equal(result.outcome, outcome);
      assert.equal(result.previousSequence, 7);
      assert.equal(result.currentSequence, status.lastEventSequence);
      assert.strictEqual(result.status, status);
      assert.equal(loads, 1);
      assert.equal(clockReads, times.length);
    });
  }
}
