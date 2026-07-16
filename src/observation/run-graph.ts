import { CueLineError } from "../core/errors.js";
import {
  loadCueLineRunTimeline,
  type CueLineRunTimeline,
  type CueLineRunTimelineOptions,
} from "./run-timeline.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

export interface CueLineRunGraphOptions extends CueLineRunTimelineOptions {}

export interface CueLineRunGraph {
  schema: "cueline-run-graph/0.1";
  runId: string;
  afterSequence: number;
  limit: number;
  totalEvents: number;
  latestSequence: number;
  returnedEvents: number;
  hasMore: boolean;
  nextAfterSequence: number;
  mermaid: string;
}

function label(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", " ");
}

function causalKey(value: string | number | boolean | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function buildCueLineRunGraph(timeline: CueLineRunTimeline): CueLineRunGraph {
  const lines = ["flowchart TD"];
  if (timeline.entries.length === 0) {
    lines.push(`  empty["No events after sequence ${timeline.afterSequence}"]`);
  } else {
    lines.push(`  start["Run ${label(timeline.runId)}"]`);
    const requestNodes = new Map<string, string>();
    const jobNodes = new Map<string, string>();
    for (const [index, entry] of timeline.entries.entries()) {
      const node = `e${entry.sequence}`;
      lines.push(
        `  ${node}["#${entry.sequence} ${entry.category}<br/>${label(entry.summary)}"]`,
      );
      lines.push(
        `  ${index === 0 ? "start" : `e${timeline.entries[index - 1]!.sequence}`} --> ${node}`,
      );
      const requestId = causalKey(entry.attributes.requestId);
      if (requestId !== undefined) {
        const previous = requestNodes.get(requestId);
        if (previous !== undefined && previous !== node) {
          lines.push(`  ${previous} -. request .-> ${node}`);
        }
        requestNodes.set(requestId, node);
      }
      const jobId = causalKey(entry.attributes.jobId);
      if (jobId !== undefined) {
        const previous = jobNodes.get(jobId);
        if (previous !== undefined && previous !== node) {
          lines.push(`  ${previous} -. job .-> ${node}`);
        }
        jobNodes.set(jobId, node);
      }
      lines.push(`  class ${node} ${entry.category}`);
    }
  }
  lines.push("  classDef run fill:#e8f0fe,stroke:#4c6ef5");
  lines.push("  classDef controller fill:#f3e8ff,stroke:#8b5cf6");
  lines.push("  classDef job fill:#e6fcf5,stroke:#0ca678");
  lines.push("  classDef runtime fill:#fff3bf,stroke:#f08c00");
  lines.push("  classDef caller_work fill:#e7f5ff,stroke:#1c7ed6");
  lines.push("  classDef cancellation fill:#ffe3e3,stroke:#e03131");
  lines.push("  classDef other fill:#f1f3f5,stroke:#868e96");
  return {
    schema: "cueline-run-graph/0.1",
    runId: timeline.runId,
    afterSequence: timeline.afterSequence,
    limit: timeline.limit,
    totalEvents: timeline.totalEvents,
    latestSequence: timeline.latestSequence,
    returnedEvents: timeline.returnedEvents,
    hasMore: timeline.hasMore,
    nextAfterSequence: timeline.nextAfterSequence,
    mermaid: lines.join("\n"),
  };
}

export async function loadCueLineRunGraph(
  runId: string,
  options: CueLineRunGraphOptions = {},
): Promise<CueLineRunGraph> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new CueLineError(
      "RUN_GRAPH_LIMIT_INVALID",
      `Run graph limit must be a safe integer from 1 through ${MAX_LIMIT}.`,
    );
  }
  const timeline = await loadCueLineRunTimeline(runId, { ...options, limit });
  return buildCueLineRunGraph(timeline);
}
