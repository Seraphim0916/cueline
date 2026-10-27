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

for (const failAt of [1, 2]) {
  test(`load ${failAt} propagates the identical error without stale results or retries`, async () => {
    const failure = new Error(`load ${failAt} failed`);
    let reads = 0;
    let clock = 0;
    const waits = [];
    const previous = { status: 'running', lastEventSequence: 7 };
    const watch = await createWatch(
      async () => {
        reads++;
        if (reads === failAt) {
          // Failure at the deadline must still reject, not return the previous status.
          clock = 10;
          throw failure;
        }
        assert.equal(reads, 1, 'must not retry after a failed load');
        return previous;
      },
      async (milliseconds) => { waits.push(milliseconds); clock += milliseconds; },
      { now: () => clock },
    );
    await assert.rejects(watch('load-error-run', {
      afterSequence: 7, timeoutMs: 10, pollIntervalMs: 5,
    }), (error) => {
      assert.strictEqual(error, failure);
      return true;
    });
    assert.equal(reads, failAt);
    assert.deepEqual(waits, failAt === 1 ? [] : [5]);
  });
}
