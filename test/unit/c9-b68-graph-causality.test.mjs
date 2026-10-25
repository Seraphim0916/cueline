import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCueLineRunGraph } from '../../dist/src/observation/run-graph.js';

function timeline(pairs, afterSequence = 0, totalEvents = afterSequence + pairs.length) {
  return {
    schema: 'cueline-timeline/0.1', runId: 'causal-run', sourceEventsPath: '',
    afterSequence, limit: pairs.length, totalEvents, latestSequence: totalEvents,
    returnedEvents: pairs.length, hasMore: afterSequence + pairs.length < totalEvents,
    nextAfterSequence: afterSequence + pairs.length,
    entries: pairs.map(([requestId, jobId], index) => ({
      sequence: afterSequence + index + 1, timestamp: null, type: 'notice',
      category: 'other', summary: `Event ${index + 1}`,
      attributes: { requestId, jobId }, payloadHash: '0'.repeat(64),
    })),
  };
}

function causalEdges(graph) {
  return graph.mermaid.split('\n').map(line => line.trim()).filter(line => line.includes(' -. '));
}

test('interleaved IDs link only to the previous event with the same ID and kind', () => {
  const graph = buildCueLineRunGraph(timeline([
    ['a', 'x'], ['b', 'y'], ['a', 'y'], ['', ''], ['a', 'x'], ['b', 'y'],
  ]));
  assert.deepEqual(causalEdges(graph), [
    'e1 -. request .-> e3', 'e2 -. job .-> e3',
    'e3 -. request .-> e5', 'e1 -. job .-> e5',
    'e2 -. request .-> e6', 'e3 -. job .-> e6',
  ]);
});

test('empty or absent IDs never establish causal chains', () => {
  assert.deepEqual(causalEdges(buildCueLineRunGraph(timeline([
    ['', ''], ['', ''], [undefined, undefined], [undefined, undefined],
  ]))), []);
});

test('identically named request and job IDs have independent histories', () => {
  const graph = buildCueLineRunGraph(timeline([
    ['shared', ''], ['', 'shared'], ['shared', 'shared'],
  ]));
  assert.deepEqual(causalEdges(graph), [
    'e1 -. request .-> e3', 'e2 -. job .-> e3',
  ]);
});

test('each page references only declared nodes, even when IDs occurred on previous pages', () => {
  const all = [['a', 'x'], ['b', 'y'], ['a', 'y'], ['', ''], ['a', 'x'], ['b', 'y']];
  for (const [offset, expected] of [
    [0, ['e1 -. request .-> e3', 'e2 -. job .-> e3']], [3, []],
  ]) {
    const graph = buildCueLineRunGraph(timeline(all.slice(offset, offset + 3), offset, all.length));
    assert.deepEqual(causalEdges(graph), expected);
    const declared = new Set([...graph.mermaid.matchAll(/^\s*(start|e\d+)\[/gm)].map(match => match[1]));
    assert.deepEqual([...declared], ['start', ...[1, 2, 3].map(n => `e${offset + n}`)]);
    const edges = [...graph.mermaid.matchAll(/^\s*(start|e\d+) (?:-->|-\. (?:request|job) \.->) (e\d+)$/gm)];
    assert.equal(edges.length, 3 + expected.length);
    for (const [, from, to] of edges) {
      assert.ok(declared.has(from), `undeclared source ${from}`);
      assert.ok(declared.has(to), `undeclared target ${to}`);
    }
  }
});
