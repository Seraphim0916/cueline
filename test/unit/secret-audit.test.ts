import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { auditCueLineRunSecrets } from "../../src/api.js";
import { initialRunState, reduceRunState } from "../../src/core/state-machine.js";
import { readEvents } from "../../src/state/event-log.js";
import { runPaths } from "../../src/state/paths.js";
import { RunStore } from "../../src/state/store.js";
import { main } from "../../src/cli/main.js";
import type { CliIo } from "../../src/cli/io.js";

// Deliberately fake, never-issued credentials shaped like real ones.
const FAKE_AWS = "AKIA" + "ABCDEFGHIJKLMNOP";
const FAKE_GITHUB = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const FAKE_ANTHROPIC = "sk-ant-" + "api03-abcdefghijklmnopqrstuvwx";
const FAKE_JWT =
  "eyJhbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiIxMjM0NTY3ODkwIn0" + "." + "abc123DEF456";

async function seededRun(secretText: string): Promise<{ home: string; runId: string }> {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-secret-audit-"));
  const runId = "run_audit";
  const store = await RunStore.create({
    home,
    runId,
    initialState: initialRunState(runId, "", "caller"),
    reducer: reduceRunState,
    now: () => new Date("2026-07-17T00:00:00.000Z"),
  });
  await store.append("run_created", { request: secretText, executor: "caller" });
  return { home, runId };
}

function collectingIo(): { io: CliIo; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    io: { stdout: (line) => lines.push(line), stderr: (line) => lines.push(line) },
  };
}

test("detects planted secret shapes with locations but never echoes the bytes", async () => {
  const planted = [
    `aws=${FAKE_AWS}`,
    `github: ${FAKE_GITHUB}`,
    `anthropic ${FAKE_ANTHROPIC}`,
    `jwt ${FAKE_JWT}`,
    'password: "correct-horse-battery"',
    "-----BEGIN RSA PRIVATE KEY-----",
  ].join("\n");
  const { home, runId } = await seededRun(planted);
  const before = await readEvents(runPaths(home, runId).events);

  const report = await auditCueLineRunSecrets(runId, { home });

  const kinds = report.findings.map((finding) => finding.kind).sort();
  assert.deepEqual(kinds, [
    "anthropic_api_key",
    "aws_access_key_id",
    "credential_assignment",
    "github_token",
    "jwt",
    "private_key_block",
  ]);
  assert.equal(report.clean, false);
  assert.equal(report.scannedEvents >= 1, true);
  for (const finding of report.findings) {
    assert.equal(finding.sequence, 1);
    assert.equal(finding.eventType, "run_created");
    assert.match(finding.path, /^payload\.request$/);
    assert.match(finding.maskedPreview, /^.{4}…\(\d+ chars\)$/);
  }
  const serialized = JSON.stringify(report);
  for (const secret of [FAKE_AWS, FAKE_GITHUB, FAKE_ANTHROPIC, FAKE_JWT]) {
    assert.equal(serialized.includes(secret), false, "report must not echo the secret");
  }
  assert.deepEqual(
    await readEvents(runPaths(home, runId).events),
    before,
    "audit must not append or rewrite run evidence",
  );
});

test("a clean run reports clean with zero findings", async () => {
  const { home, runId } = await seededRun(
    "ordinary request text with no credentials at all",
  );
  const report = await auditCueLineRunSecrets(runId, { home });
  assert.equal(report.clean, true);
  assert.deepEqual(report.findings, []);
});

test("overlapping detectors claim each span once: sk-ant is not also sk-", async () => {
  const { home, runId } = await seededRun(FAKE_ANTHROPIC);
  const report = await auditCueLineRunSecrets(runId, { home });
  assert.deepEqual(
    report.findings.map((finding) => finding.kind),
    ["anthropic_api_key"],
  );
});

test("a secret-shaped object key is reported and never echoed in any path", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-secret-audit-key-"));
  const runId = "run_key_leak";
  const store = await RunStore.create({
    home,
    runId,
    initialState: initialRunState(runId, "", "caller"),
    reducer: reduceRunState,
    now: () => new Date("2026-07-17T00:00:00.000Z"),
  });
  await store.append("run_created", {
    request: "plain request",
    executor: "caller",
    [FAKE_GITHUB]: `api_key=${FAKE_AWS}FILLERFILLER`,
  });

  const report = await auditCueLineRunSecrets(runId, { home });

  assert.equal(report.clean, false);
  const kinds = new Set(report.findings.map((finding) => finding.kind));
  assert.equal(kinds.has("github_token"), true, "the key itself must be a finding");
  const serialized = JSON.stringify(report);
  assert.equal(
    serialized.includes(FAKE_GITHUB),
    false,
    "a secret-shaped key must not appear verbatim anywhere in the report",
  );
  assert.equal(
    serialized.includes(FAKE_AWS),
    false,
    "the value must stay masked as before",
  );
  for (const finding of report.findings) {
    assert.equal(
      finding.path.includes(FAKE_GITHUB),
      false,
      `path leaked the key: ${finding.path}`,
    );
  }
});

test("a missing run fails closed instead of reporting clean", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-secret-audit-missing-"));
  await assert.rejects(
    auditCueLineRunSecrets("run_absent", { home }),
    (error: unknown) =>
      error instanceof Error && error.message.includes("run_absent"),
  );
  const io = collectingIo();
  assert.equal(
    await main(
      ["run", "audit-secrets", "run_absent"],
      { CUELINE_HOME: home, HOME: home },
      io.io,
    ),
    1,
  );
  assert.match(io.lines.join("\n"), /RUN_NOT_FOUND/);
});

test("the CLI exits 0 on clean, 1 on findings, 2 on usage", async () => {
  const { home, runId } = await seededRun(`token=${FAKE_GITHUB}`);
  const environment = { CUELINE_HOME: home, HOME: home };

  const dirty = collectingIo();
  assert.equal(
    await main(["run", "audit-secrets", runId, "--json"], environment, dirty.io),
    1,
  );
  assert.equal(dirty.lines.join("\n").includes(FAKE_GITHUB), false);

  const clean = await seededRun("nothing secret here");
  const cleanIo = collectingIo();
  assert.equal(
    await main(
      ["run", "audit-secrets", clean.runId],
      { CUELINE_HOME: clean.home, HOME: clean.home },
      cleanIo.io,
    ),
    0,
  );
  assert.match(cleanIo.lines.join("\n"), /clean\tyes/);

  const usage = collectingIo();
  assert.equal(
    await main(["run", "audit-secrets", runId, "--bogus"], environment, usage.io),
    2,
  );
});
