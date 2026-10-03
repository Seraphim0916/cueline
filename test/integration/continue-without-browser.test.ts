import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  continueCueLineRun,
  loadCueLineRunStatus,
  startCueLineRun,
} from "../../src/api.js";

// M-91: on a host without the Codex in-app Browser (for example a Claude Code
// host calling the MCP tool), continue must refuse before touching the run.

test("continue without any browser runtime refuses without failing the run or spending a round", async () => {
  const globals = globalThis as { iab?: unknown; agent?: unknown };
  assert.equal(globals.iab, undefined);
  assert.equal(globals.agent, undefined);

  const home = await mkdtemp(path.join(tmpdir(), "cueline-no-browser-"));
  const runId = "run_no_browser_m91";
  await startCueLineRun({ request: "Probe a host without a browser", runId, home });
  const before = await loadCueLineRunStatus(runId, { home });

  await assert.rejects(continueCueLineRun({ runId, home }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "IAB_BROWSER_MISSING");
    return true;
  });

  const after = await loadCueLineRunStatus(runId, { home });
  assert.equal(after.status, before.status);
  assert.equal(after.phase, before.phase);
  assert.equal(after.round, before.round);
  assert.equal(after.continueAllowed, before.continueAllowed);
});
