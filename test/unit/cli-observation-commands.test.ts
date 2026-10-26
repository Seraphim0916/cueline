import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { CliIo } from "../../src/cli/io.js";
import { handleObservationCommand } from "../../src/cli/observation-commands.js";
import { CueLineError } from "../../src/core/errors.js";
import { jobId } from "../../src/core/ids.js";
import { initialRunState, reduceRunState } from "../../src/core/state-machine.js";
import { runPaths } from "../../src/state/paths.js";
import { RunStore } from "../../src/state/store.js";
import { CUELINE_VERSION } from "../../src/version.js";

interface Captured {
  io: CliIo;
  stdout: string[];
  stderr: string[];
}

function capture(): Captured {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    stdout,
    stderr,
  };
}

async function fixture(): Promise<{ stateHome: string; environment: NodeJS.ProcessEnv }> {
  const stateHome = await mkdtemp(path.join(tmpdir(), "cueline-unit-cli-observe-"));
  return { stateHome, environment: { CUELINE_HOME: stateHome, HOME: stateHome } };
}

async function seedRun(stateHome: string, runId: string, complete = false): Promise<void> {
  const store = await RunStore.create({
    home: stateHome,
    runId,
    initialState: initialRunState(runId, "", "caller"),
    reducer: reduceRunState,
    now: () => new Date("2026-10-26T00:00:00.000Z"),
  });
  await store.append("run_created", { request: `request ${runId}`, executor: "caller" });
  const spec = { job_key: "review", lane: "default", mode: "advise" as const, task: "t", required: true };
  await store.append("job_registered", {
    job: {
      jobId: jobId(runId, spec.job_key, spec),
      jobKey: spec.job_key,
      required: true,
      spec,
      status: "pending",
      output: null,
      error: null,
    },
  });
  if (complete) await store.append("run_completed", { final_delivery_text: "done" });
}

async function run(
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ code: number | undefined } & Captured> {
  const captured = capture();
  const code = await handleObservationCommand(args, environment, captured.io);
  return { code, ...captured };
}

async function usageError(args: string[], environment: NodeJS.ProcessEnv): Promise<string> {
  let message = "";
  await assert.rejects(handleObservationCommand(args, environment, capture().io), (error) => {
    assert.ok(error instanceof CueLineError, `${args.join(" ")}: ${String(error)}`);
    assert.equal(error.code, "CLI_ARGUMENTS_INVALID", args.join(" "));
    message = error.message;
    return true;
  });
  return message;
}

test("commands outside the observation surface fall through as undefined", async () => {
  const { environment } = await fixture();
  for (const args of [
    [],
    ["runs", "--yaml"],
    ["runs", "--json", "--json"],
    ["run", "verify"],
    ["run", "verify", "run_x", "--yaml"],
    ["run", "doctor", "run_x", "--json", "extra"],
    ["run", "diff", "run_a"],
    ["run", "audit-secrets", "run_x", "--text"],
    ["run", "unknown", "run_x"],
    ["job", "cancel"],
  ]) {
    const result = await run(args, environment);
    assert.equal(result.code, undefined, args.join(" "));
    assert.deepEqual(result.stdout, []);
  }
});

test("runs lists readable runs, flags unreadable ones, and returns 1 when any is unreadable", async () => {
  const { stateHome, environment } = await fixture();
  const empty = await run(["runs"], environment);
  assert.equal(empty.code, 0);
  assert.deepEqual(empty.stdout, ["No runs."]);
  const emptyJson = await run(["runs", "--json"], environment);
  assert.deepEqual(JSON.parse(emptyJson.stdout.join("\n")), []);

  await seedRun(stateHome, "run_ok");
  const one = await run(["runs"], environment);
  assert.equal(one.code, 0);
  assert.equal(one.stdout.length, 1);
  assert.match(one.stdout[0]!, /^run_ok\trunning\tcaller\t.*\tround=0\tpending=0\tactive_jobs=1\truntime=\w+\tsequence=2\tupdated=2026-10-26T00:00:00.000Z$/);

  await mkdir(runPaths(stateHome, "run_broken").runDir, { recursive: true });
  const mixed = await run(["runs"], environment);
  assert.equal(mixed.code, 1);
  assert.ok(mixed.stdout.some((line) => /^run_broken\tunreadable\t\S+$/.test(line)), mixed.stdout.join("\n"));
  const mixedJson = await run(["runs", "--json"], environment);
  assert.equal(mixedJson.code, 1);
  const parsed = JSON.parse(mixedJson.stdout.join("\n")) as Array<{ runId: string; readable: boolean }>;
  assert.deepEqual(
    parsed.map((entry) => [entry.runId, entry.readable]).sort(),
    [["run_broken", false], ["run_ok", true]],
  );
});

test("run verify renders text and JSON and maps the outcome to the exit code", async () => {
  const { stateHome, environment } = await fixture();
  await seedRun(stateHome, "run_verify");

  const text = await run(["run", "verify", "run_verify"], environment);
  assert.equal(text.code, 0);
  assert.equal(text.stdout[0], "run\trun_verify");
  assert.equal(text.stdout[1], "outcome\tverified");
  assert.ok(text.stdout.includes("events\treadable\ttotal=2\tauthoritative=2\tlast_sequence=2"));

  const json = await run(["run", "verify", "run_verify", "--json"], environment);
  assert.equal(JSON.parse(json.stdout.join("\n")).outcome, "verified");

  const missing = await run(["run", "verify", "run_missing"], environment);
  assert.equal(missing.code, 1);
  assert.ok(missing.stdout.includes("outcome\tunreadable"));
  assert.ok(missing.stdout.includes("finding\terror\tRUN_STATUS_UNREADABLE\tevents\tThe run cannot be reduced into a complete status summary."));
});

test("run export validates its flags, writes a new private file, and never overwrites", async () => {
  const { stateHome, environment } = await fixture();
  await seedRun(stateHome, "run_export");
  for (const args of [
    ["--limit", "0"],
    ["--limit", "1001"],
    ["--limit", "1.5"],
    ["--limit", ""],
    ["--limit", "5", "--limit", "6"],
    ["--json", "--json"],
    ["--out"],
    ["--verbose"],
  ]) {
    const message = await usageError(["run", "export", "run_export", ...args], environment);
    assert.match(message, /^usage: cueline run export/);
  }

  const out = path.join(stateHome, "bundle.json");
  const text = await run(["run", "export", "run_export", "--out", out, "--limit", "1000"], environment);
  assert.equal(text.code, 0);
  assert.equal(text.stdout[0], "run\trun_export");
  assert.equal(text.stdout.at(-1), `written\t${out}`);
  const written = await readFile(out, "utf8");
  assert.equal(JSON.parse(written).runId, "run_export");
  assert.equal((await stat(out)).mode & 0o777, 0o600);

  await assert.rejects(
    handleObservationCommand(["run", "export", "run_export", "--out", out], environment, capture().io),
    { code: "RUN_BUNDLE_OUT_EXISTS" },
  );
  assert.equal(await readFile(out, "utf8"), written);

  const json = await run(["run", "export", "run_export", "--json", "--limit", "1"], environment);
  const bundle = JSON.parse(json.stdout.join("\n")) as { runId: string; timeline: { returnedEvents: number } };
  assert.equal(bundle.runId, "run_export");
  assert.equal(bundle.timeline.returnedEvents, 1);
  const plain = await run(["run", "export", "run_export"], environment);
  assert.equal(plain.stdout.at(-1), "written\t-");
});

test("run audit-secrets and run doctor render both formats", async () => {
  const { stateHome, environment } = await fixture();
  await seedRun(stateHome, "run_audit");

  const audit = await run(["run", "audit-secrets", "run_audit"], environment);
  assert.equal(audit.code, 0);
  assert.deepEqual(audit.stdout.slice(0, 2), ["run\trun_audit", `version\t${CUELINE_VERSION}`]);
  assert.equal(audit.stdout.at(-1), "clean\tyes");
  const auditJson = await run(["run", "audit-secrets", "run_audit", "--json"], environment);
  const auditReport = JSON.parse(auditJson.stdout.join("\n")) as { schema: string; clean: boolean };
  assert.equal(auditReport.schema, "cueline-run-audit-secrets/1");
  assert.equal(auditReport.clean, true);

  const doctor = await run(["run", "doctor", "run_audit"], environment);
  assert.equal(doctor.stdout[0], "run\trun_audit");
  assert.ok(doctor.stdout.some((line) => line.startsWith("next\t")));
  const doctorJson = await run(["run", "doctor", "run_audit", "--json"], environment);
  const diagnosis = JSON.parse(doctorJson.stdout.join("\n")) as { version: string; outcome: string };
  assert.equal(diagnosis.version, CUELINE_VERSION);
  assert.equal(doctor.code, diagnosis.outcome === "blocked" ? 1 : 0);
});

test("run status-at requires one positive --sequence and renders the historical state", async () => {
  const { stateHome, environment } = await fixture();
  await seedRun(stateHome, "run_at");
  for (const args of [
    [],
    ["--sequence", "0"],
    ["--sequence", "-1"],
    ["--sequence", "1.5"],
    ["--sequence", "1", "--sequence", "2"],
    ["--sequence"],
    ["--sequence", "1", "--json", "--json"],
  ]) {
    await usageError(["run", "status-at", "run_at", ...args], environment);
  }

  const text = await run(["run", "status-at", "run_at", "--sequence", "2"], environment);
  assert.equal(text.code, 0);
  assert.deepEqual(text.stdout, [
    "run\trun_at",
    `version\t${CUELINE_VERSION}`,
    "sequence\t2/2\tauthoritative_applied=2",
    "event\tjob_registered\t2026-10-26T00:00:00.000Z",
    "state\trunning\texecutor=caller\tround=0/12\tstagnation=0/12",
    "controller\tpending=0\tabandoned=0\taccepted=0",
    'jobs\ttotal=1\tcounts={"pending":1}',
  ]);
  const json = await run(["run", "status-at", "run_at", "--json", "--sequence", "1"], environment);
  const parsed = JSON.parse(json.stdout.join("\n")) as { version: string; requestedSequence: number };
  assert.equal(parsed.version, CUELINE_VERSION);
  assert.equal(parsed.requestedSequence, 1);
});

test("run diff reports equivalence and each changed field", async () => {
  const { stateHome, environment } = await fixture();
  await seedRun(stateHome, "run_left");
  await seedRun(stateHome, "run_right", true);

  const text = await run(["run", "diff", "run_left", "run_right"], environment);
  assert.equal(text.code, 0);
  assert.deepEqual(text.stdout.slice(0, 3), ["left\trun_left", "right\trun_right", "equivalent\tno"]);
  assert.ok(text.stdout.some((line) => line.startsWith("change\tstatus\t")), text.stdout.join("\n"));
  const json = await run(["run", "diff", "run_left", "run_right", "--json"], environment);
  const parsed = JSON.parse(json.stdout.join("\n")) as { equivalent: boolean; changes: unknown[] };
  assert.equal(parsed.equivalent, false);
  assert.ok(parsed.changes.length > 0);
});

test("run watch validates bounds, times out at the current sequence, and returns on a change", async () => {
  const { stateHome, environment } = await fixture();
  await seedRun(stateHome, "run_watch");
  for (const args of [
    [],
    ["--after", " "],
    ["--after", "-1"],
    ["--after", "0", "--timeout-ms", "30001"],
    ["--after", "0", "--timeout-ms", "-1"],
    ["--after", "0", "--timeout-ms", ""],
    ["--after", "0", "--after", "1"],
  ]) {
    await usageError(["run", "watch", "run_watch", ...args], environment);
  }

  const timedOut = await run(["run", "watch", "run_watch", "--after", "2", "--timeout-ms", "0"], environment);
  assert.equal(timedOut.code, 0);
  assert.ok(timedOut.stdout.includes("outcome\ttimed_out"), timedOut.stdout.join("\n"));
  assert.ok(timedOut.stdout.includes("sequence\t2->2"));

  const changed = await run(["run", "watch", "run_watch", "--after", "1", "--json"], environment);
  const parsed = JSON.parse(changed.stdout.join("\n")) as { outcome: string; currentSequence: number };
  assert.equal(parsed.outcome, "changed");
  assert.equal(parsed.currentSequence, 2);
});

test("run handoff only accepts a content cap together with --include-content", async () => {
  const { stateHome, environment } = await fixture();
  await seedRun(stateHome, "run_handoff");
  for (const args of [
    ["--max-content-chars", "100"],
    ["--include-content", "--max-content-chars", "15"],
    ["--include-content", "--max-content-chars", "10001"],
    ["--include-content", "--include-content"],
    ["--other"],
  ]) {
    await usageError(["run", "handoff", "run_handoff", ...args], environment);
  }

  const markdown = await run(["run", "handoff", "run_handoff"], environment);
  assert.equal(markdown.code, 0);
  assert.equal(markdown.stdout.length, 1);
  assert.match(markdown.stdout[0]!, /run_handoff/);
  const json = await run(
    ["run", "handoff", "run_handoff", "--include-content", "--max-content-chars", "16", "--json"],
    environment,
  );
  const packet = JSON.parse(json.stdout.join("\n")) as {
    run: { runId: string };
    contentPolicy: string;
    content?: { request: string };
  };
  assert.equal(packet.run.runId, "run_handoff");
  assert.equal(packet.contentPolicy, "bounded_request_and_tasks");
  assert.ok((packet.content?.request.length ?? Infinity) <= 16, JSON.stringify(packet.content));
});

test("run timeline and run graph enforce their different limit ceilings", async () => {
  const { stateHome, environment } = await fixture();
  await seedRun(stateHome, "run_page");
  for (const command of ["timeline", "graph"]) {
    for (const args of [
      ["--after", "-1"],
      ["--after", ""],
      ["--limit", "0"],
      ["--limit", "1.5"],
      ["--after", "0", "--after", "0"],
      ["--limit", "1", "--limit", "1"],
      ["--json", "--json"],
    ]) {
      await usageError(["run", command, "run_page", ...args], environment);
    }
  }
  await usageError(["run", "timeline", "run_page", "--limit", "1001"], environment);
  await usageError(["run", "graph", "run_page", "--limit", "201"], environment);

  const timeline = await run(["run", "timeline", "run_page", "--limit", "1000", "--after", "1"], environment);
  assert.equal(timeline.code, 0);
  assert.equal(timeline.stdout[0], "run\trun_page");
  assert.equal(timeline.stdout[2], "events\treturned=1\ttotal=2\tlatest=2\thas_more=no\tnext_after=2");
  assert.match(timeline.stdout[3]!, /^event\t2\t2026-10-26T00:00:00.000Z\t\S+\tjob_registered\t/);
  const page = await run(["run", "timeline", "run_page", "--limit", "1", "--json"], environment);
  const parsed = JSON.parse(page.stdout.join("\n")) as { hasMore: boolean; returnedEvents: number };
  assert.equal(parsed.hasMore, true);
  assert.equal(parsed.returnedEvents, 1);

  const graph = await run(["run", "graph", "run_page", "--limit", "200"], environment);
  assert.equal(graph.code, 0);
  assert.equal(graph.stdout.length, 1);
  assert.match(graph.stdout[0]!, /^(flowchart|graph)\b/);
  const graphJson = await run(["run", "graph", "run_page", "--json"], environment);
  const graphParsed = JSON.parse(graphJson.stdout.join("\n")) as { version: string; mermaid: string };
  assert.equal(graphParsed.version, CUELINE_VERSION);
  assert.equal(graphParsed.mermaid, graph.stdout[0]);
});

test("export --out refuses a path inside a missing directory without creating it", async () => {
  const { stateHome, environment } = await fixture();
  await seedRun(stateHome, "run_export_missing_dir");
  const out = path.join(stateHome, "missing", "bundle.json");
  await assert.rejects(
    handleObservationCommand(["run", "export", "run_export_missing_dir", "--out", out], environment, capture().io),
    { code: "ENOENT" },
  );
  await assert.rejects(stat(path.dirname(out)), { code: "ENOENT" });
});
