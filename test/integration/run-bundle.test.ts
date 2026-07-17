import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCueLineRunSupportBundle } from "../../src/api.js";
import { initialRunState, reduceRunState } from "../../src/core/state-machine.js";
import { readEvents } from "../../src/state/event-log.js";
import { runPaths } from "../../src/state/paths.js";
import { RunStore } from "../../src/state/store.js";
import { main } from "../../src/cli/main.js";
import type { CliIo } from "../../src/cli/io.js";

async function seededHome(): Promise<{ home: string; runId: string }> {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-run-bundle-"));
  const runId = "run_bundle";
  const store = await RunStore.create({
    home,
    runId,
    initialState: initialRunState(runId, "", "caller"),
    reducer: reduceRunState,
    now: () => new Date("2026-07-17T00:00:00.000Z"),
  });
  await store.append("run_created", {
    request: "PRIVATE REQUEST bundle secret text",
    executor: "caller",
  });
  await store.append("run_completed", {
    final_delivery_text: "PRIVATE RESULT bundle delivery",
  });
  return { home, runId };
}

function collectingIo(): { io: CliIo; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    io: { stdout: (line) => lines.push(line), stderr: (line) => lines.push(line) },
  };
}

test("the bundle composes sanitized surfaces and never leaks run content", async () => {
  const { home, runId } = await seededHome();
  const before = await readEvents(runPaths(home, runId).events);

  const bundle = await buildCueLineRunSupportBundle(runId, {
    home,
    now: () => new Date("2026-07-17T01:00:00.000Z"),
  });

  assert.equal(bundle.protocol, "cueline-run-bundle/0.1");
  assert.equal(bundle.runId, runId);
  assert.equal(bundle.generatedAt, "2026-07-17T01:00:00.000Z");
  assert.equal(bundle.status.status, "complete");
  assert.equal(bundle.verification.outcome, "verified");
  assert.equal(typeof bundle.diagnosis.outcome, "string");
  assert.equal(bundle.timeline.totalEvents, 2);
  assert.equal(bundle.timeline.entries.length, 2);
  for (const entry of bundle.timeline.entries) {
    assert.match(entry.payloadHash, /^[0-9a-f]{64}$/);
  }
  const serialized = JSON.stringify(bundle);
  assert.doesNotMatch(serialized, /PRIVATE REQUEST|PRIVATE RESULT/);
  assert.deepEqual(
    await readEvents(runPaths(home, runId).events),
    before,
    "bundling must not append or rewrite run evidence",
  );
});

test("timelineLimit is validated and bounds the returned entries", async () => {
  const { home, runId } = await seededHome();
  const bounded = await buildCueLineRunSupportBundle(runId, { home, timelineLimit: 1 });
  assert.equal(bounded.timeline.returnedEvents, 1);
  assert.equal(bounded.timeline.hasMore, true);
  await assert.rejects(
    buildCueLineRunSupportBundle(runId, { home, timelineLimit: 0 }),
    /RUN_BUNDLE_LIMIT_INVALID|timelineLimit/,
  );
});

test("the CLI prints, writes once with --out, and validates arguments", async () => {
  const { home, runId } = await seededHome();
  const environment = { CUELINE_HOME: home, HOME: home };

  const printed = collectingIo();
  assert.equal(
    await main(["run", "export", runId, "--json"], environment, printed.io),
    0,
  );
  const parsed = JSON.parse(printed.lines.join("\n")) as { protocol: string };
  assert.equal(parsed.protocol, "cueline-run-bundle/0.1");
  assert.doesNotMatch(printed.lines.join("\n"), /PRIVATE REQUEST|PRIVATE RESULT/);

  const outPath = path.join(home, "bundle.json");
  const written = collectingIo();
  assert.equal(
    await main(["run", "export", runId, "--out", outPath], environment, written.io),
    0,
  );
  assert.match(written.lines.join("\n"), /verification\tverified/);
  const onDisk = JSON.parse(await readFile(outPath, "utf8")) as { runId: string };
  assert.equal(onDisk.runId, runId);

  const overwrite = collectingIo();
  assert.equal(
    await main(["run", "export", runId, "--out", outPath], environment, overwrite.io),
    1,
  );
  assert.match(overwrite.lines.join("\n"), /RUN_BUNDLE_OUT_EXISTS/);

  const missing = collectingIo();
  assert.equal(
    await main(["run", "export", "run_absent"], environment, missing.io),
    1,
  );

  const usage = collectingIo();
  assert.equal(
    await main(["run", "export", runId, "--limit", "0"], environment, usage.io),
    2,
  );
});
