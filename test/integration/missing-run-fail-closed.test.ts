import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../../src/cli/main.js";
import type { CliIo } from "../../src/cli/io.js";

// Round-1 adversarial smoke found run audit-secrets reporting a missing run
// as clean because readAuthoritativeRunEvents yields [] for an absent run.
// This sweep pins the invariant for every run-scoped read surface: an absent
// run must exit nonzero with an error line, never fabricate a success view.
const READ_SURFACES: string[][] = [
  ["run", "status", "run_absent"],
  ["run", "status-at", "run_absent", "--sequence", "1"],
  ["run", "diff", "run_absent", "run_absent_too"],
  ["run", "doctor", "run_absent"],
  ["run", "watch", "run_absent", "--after", "1", "--timeout-ms", "0"],
  ["run", "handoff", "run_absent"],
  ["run", "timeline", "run_absent"],
  ["run", "graph", "run_absent"],
  ["run", "verify", "run_absent"],
  ["run", "audit-secrets", "run_absent"],
  ["run", "export", "run_absent"],
];

function collectingIo(): { io: CliIo; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    io: { stdout: (line) => lines.push(line), stderr: (line) => lines.push(line) },
  };
}

test("every run-scoped read surface fails closed for an absent run", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-missing-run-"));
  const environment = { CUELINE_HOME: home, HOME: home };
  for (const argv of READ_SURFACES) {
    const { io, lines } = collectingIo();
    const exitCode = await main(argv, environment, io);
    const surface = argv.join(" ");
    const output = lines.join("\n");
    assert.notEqual(exitCode, 0, `${surface} exited 0 for an absent run:\n${output}`);
    assert.match(
      output,
      /RUN_NOT_FOUND|RUN_UNREADABLE|RUN_MARKER_MISSING|RUN_STATUS_UNREADABLE|unreadable|not.*found|no durable events/i,
      `${surface} did not name the missing run problem:\n${output}`,
    );
    assert.doesNotMatch(
      output,
      /\bstatus\tcomplete\b|\bclean\tyes\b|\bverified\b/,
      `${surface} fabricated a healthy view for an absent run:\n${output}`,
    );
  }
});

test("run-scoped mutating surfaces also refuse an absent run", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-missing-run-mut-"));
  const environment = { CUELINE_HOME: home, HOME: home };
  const surfaces: string[][] = [
    ["run", "takeover", "run_absent"],
    ["run", "reconcile-runtime", "run_absent"],
    ["run", "cancel", "run_absent"],
    [
      "run",
      "reconcile",
      "run_absent",
      "--request-id",
      "msg_x",
      "--manual-send-confirmed",
    ],
    ["job", "cancel", "run_absent", "job_x"],
  ];
  for (const argv of surfaces) {
    const { io, lines } = collectingIo();
    const exitCode = await main(argv, environment, io);
    const surface = argv.join(" ");
    assert.notEqual(
      exitCode,
      0,
      `${surface} exited 0 for an absent run:\n${lines.join("\n")}`,
    );
  }
});
