import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createCueLineRunHandoff,
  renderCueLineRunHandoffMarkdown,
  startCueLineRun,
} from "../../src/api.js";
import { CueLineError } from "../../src/core/errors.js";

async function environmentFor(home: string): Promise<NodeJS.ProcessEnv> {
  return {
    ...process.env,
    CUELINE_HOME: home,
    CUELINE_CONFIG: path.resolve("config/routing.default.json"),
  };
}

async function startedRun(): Promise<{ runId: string; home: string; environment: NodeJS.ProcessEnv }> {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-handoff-"));
  const environment = await environmentFor(home);
  const started = await startCueLineRun({
    request: "durable run for handoff public API",
    home,
    environment,
  });
  return { runId: started.runId, home, environment };
}

test("createCueLineRunHandoff builds a metadata-only packet and renders markdown", async () => {
  const { runId, home, environment } = await startedRun();
  const packet = await createCueLineRunHandoff(runId, { home, environment });
  assert.equal(packet.schema, "cueline-handoff/0.1");
  // Without includeContent the packet carries no raw content projection.
  assert.equal("content" in packet, false);
  const markdown = renderCueLineRunHandoffMarkdown(packet);
  assert.equal(typeof markdown, "string");
  assert.ok(markdown.length > 0);
});

test("createCueLineRunHandoff attaches a bounded content projection only when asked", async () => {
  const { runId, home, environment } = await startedRun();
  const packet = await createCueLineRunHandoff(runId, {
    home,
    environment,
    includeContent: true,
    maxContentChars: 100,
  });
  assert.equal("content" in packet, true);
});

test("createCueLineRunHandoff rejects an out-of-range or non-integer maxContentChars", async () => {
  const { runId, home, environment } = await startedRun();
  for (const maxContentChars of [15, 10_001, 1.5, Number.NaN]) {
    await assert.rejects(
      createCueLineRunHandoff(runId, { home, environment, includeContent: true, maxContentChars }),
      (error: unknown) =>
        error instanceof CueLineError && error.code === "RUN_HANDOFF_OPTIONS_INVALID",
    );
  }
});

test("createCueLineRunHandoff fails closed on an absent run", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-handoff-"));
  const environment = await environmentFor(home);
  await assert.rejects(
    createCueLineRunHandoff("run_absent", { home, environment }),
    (error: unknown) => error instanceof CueLineError && error.code === "RUN_NOT_FOUND",
  );
});
