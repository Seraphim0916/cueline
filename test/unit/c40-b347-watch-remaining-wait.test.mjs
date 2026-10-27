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

for (const [loadedAt, expectedWaits] of [[8, [2]], [5, [5]], [2, [5, 3]]]) {
  test(`remaining ${10 - loadedAt}ms respects the 5ms polling interval and deadline`, async () => {
    let clock = 0;
    let reads = 0;
    const waits = [];
    const statuses = [];
    const watch = await createWatch(
      async () => {
        if (++reads === 1) clock = loadedAt;
        assert.ok(reads <= expectedWaits.length + 1, 'unexpected extra load');
        const status = { status: 'running', lastEventSequence: 4 };
        statuses.push(status);
        return status;
      },
      async (milliseconds) => {
        assert.ok(milliseconds > 0 && milliseconds <= 10 - clock);
        waits.push(milliseconds);
        clock += milliseconds;
      }, { now: () => clock },
    );
    const result = await watch('remaining-wait-run', {
      afterSequence: 4, timeoutMs: 10, pollIntervalMs: 5,
    });
    assert.deepEqual(waits, expectedWaits);
    assert.equal(reads, expectedWaits.length + 1);
    assert.equal(result.outcome, 'timed_out');
    assert.equal(result.elapsedMs, 10);
    assert.equal(result.previousSequence, 4);
    assert.equal(result.currentSequence, 4);
    assert.strictEqual(result.status, statuses.at(-1));
  });
}
