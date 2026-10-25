import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import test from 'node:test';

const sourceRoot = new URL('../../src/', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot)
        && specifier.startsWith('.') && specifier.endsWith('.js')) {
      return nextResolve(specifier.slice(0, -3) + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) {
      return { format: 'module', shortCircuit: true,
        source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8')) };
    }
    return nextLoad(url, context);
  },
});
let buildCueLineRunTimeline;
try {
  ({ buildCueLineRunTimeline } = await import('../../src/observation/run-timeline.ts'));
} finally {
  hooks.deregister();
}

const sequences = [2, 7, 11, 23, 40];
const events = sequences.map(sequence => ({ sequence,
  timestamp: '2026-10-26T00:00:00.000Z', type: 'run_created',
  payload: { request: `synthetic-${sequence}` },
}));

for (const limit of [1, 2, 3, 5, 8]) {
  for (const start of [0, 4, 9, 24, 40]) {
    test(`sparse pagination merges every entry once: limit=${limit}, cursor=${start}`, () => {
      const before = structuredClone(events);
      const expected = buildCueLineRunTimeline('run_sparse', events, tmpdir(),
        { afterSequence: start, limit: 100 }).entries;
      const merged = [];
      let cursor = start;
      let ended = false;
      for (let pageNumber = 0; pageNumber <= events.length; pageNumber += 1) {
        const options = { afterSequence: cursor, limit };
        const page = buildCueLineRunTimeline('run_sparse', events, tmpdir(), options);
        const remaining = sequences.filter(sequence => sequence > cursor);
        assert.deepEqual(page.entries.map(entry => entry.sequence), remaining.slice(0, limit));
        assert.equal(page.afterSequence, cursor);
        assert.equal(page.returnedEvents, page.entries.length);
        assert.equal(page.totalEvents, sequences.length);
        assert.equal(page.latestSequence, 40);
        assert.equal(page.hasMore, remaining.length > limit);
        assert.equal(page.nextAfterSequence, remaining.slice(0, limit).at(-1) ?? cursor);
        assert.deepEqual(options, { afterSequence: cursor, limit });
        merged.push(...page.entries);
        cursor = page.nextAfterSequence;
        if (!page.hasMore) {
          ended = true;
          const tail = buildCueLineRunTimeline('run_sparse', events, tmpdir(),
            { afterSequence: cursor, limit });
          assert.deepEqual(tail.entries, []);
          assert.equal(tail.returnedEvents, 0);
          assert.equal(tail.nextAfterSequence, cursor);
          assert.equal(tail.hasMore, false);
          break;
        }
      }
      assert.equal(ended, true, 'pagination must terminate');
      assert.deepEqual(merged, expected);
      assert.equal(new Set(merged.map(entry => entry.sequence)).size, merged.length);
      assert.deepEqual(events, before);
    });
  }
}
