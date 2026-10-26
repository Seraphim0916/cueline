import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const moduleUrl = source => `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`;
const errors = moduleUrl(await readFile(new URL('../../src/core/errors.ts', import.meta.url), 'utf8'));
const source = stripTypeScriptTypes(await readFile(new URL('../../src/observation/run-graph.ts', import.meta.url), 'utf8'));
const { buildCueLineRunGraph } = await import(moduleUrl(source
  .replace('"../core/errors.js"', JSON.stringify(errors))
  .replace(/import\s*\{\s*loadCueLineRunTimeline\s*,?\s*\}\s*from "\.\/run-timeline.js";/,
    'const loadCueLineRunTimeline = () => { throw new Error("unexpected storage access"); };')));

for (const scenario of [
  { name: 'entire history empty', afterSequence: 0, totalEvents: 0, latestSequence: 0, nextAfterSequence: 0, limit: 100 },
  { name: 'sparse sequence history exhausted', afterSequence: 90, totalEvents: 8, latestSequence: 90, nextAfterSequence: 90, limit: 7 },
  { name: 'cursor beyond latest event', afterSequence: 120, totalEvents: 8, latestSequence: 90, nextAfterSequence: 120, limit: 200 },
]) {
  test(`empty graph retains metadata: ${scenario.name}`, () => {
    const { name, ...metadata } = scenario;
    const timeline = {
      schema: 'cueline-timeline/0.1', runId: 'run-empty', sourceEventsPath: 'unused',
      ...metadata, returnedEvents: 0, hasMore: false, entries: [],
    };
    const before = structuredClone(timeline);
    Object.freeze(timeline.entries);
    Object.freeze(timeline);
    const graph = buildCueLineRunGraph(timeline);
    const { mermaid, ...actualMetadata } = graph;
    assert.deepEqual(actualMetadata, {
      schema: 'cueline-run-graph/0.1', runId: 'run-empty', ...metadata,
      returnedEvents: 0, hasMore: false,
    });
    assert.equal(mermaid.split('\n')[0], 'flowchart TD');
    assert.equal(mermaid.split('\n')[1], `  empty["No events after sequence ${metadata.afterSequence}"]`);
    assert.doesNotMatch(mermaid, /-->|\.->|\be\d+\[|\bstart\[/);
    assert.deepEqual(timeline, before);
    assert.notEqual(graph, timeline);
    console.log(name, 'totalEvents', graph.totalEvents, 'latestSequence', graph.latestSequence,
      'nextAfterSequence', graph.nextAfterSequence, 'limit', graph.limit, 'unchanged', true);
  });
}
