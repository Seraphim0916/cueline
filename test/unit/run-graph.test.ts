import assert from "node:assert/strict";
import test from "node:test";

import { buildCueLineRunGraph } from "../../src/observation/run-graph.js";
import type { CueLineRunTimeline } from "../../src/observation/run-timeline.js";

test("run graph escapes arbitrary labels before embedding them in Mermaid", () => {
  const timeline: CueLineRunTimeline = {
    schema: "cueline-timeline/0.1",
    runId: "run_escape",
    sourceEventsPath: "/private/events.jsonl",
    afterSequence: 0,
    limit: 1,
    totalEvents: 1,
    latestSequence: 1,
    returnedEvents: 1,
    hasMore: false,
    nextAfterSequence: 1,
    entries: [
      {
        sequence: 1,
        timestamp: null,
        type: "unknown_event",
        category: "other",
        summary: 'unsafe "] <script>\nnext',
        attributes: {},
        payloadHash: "0".repeat(64),
      },
    ],
  };

  const graph = buildCueLineRunGraph(timeline);

  assert.doesNotMatch(graph.mermaid, /<script>/);
  assert.match(graph.mermaid, /&lt;script&gt;/);
  assert.match(graph.mermaid, /\\"\]/);
  assert.doesNotMatch(graph.mermaid, /\nnext/);
});
