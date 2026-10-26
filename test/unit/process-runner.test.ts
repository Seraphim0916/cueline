import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CueLineError } from "../../src/core/errors.js";
import { ProcessRunner } from "../../src/runners/process-runner.js";
import { RunnerRegistry } from "../../src/runners/registry.js";
import type { RunnerSpec } from "../../src/runners/runner-adapter.js";

// Children are short-lived `node -e` scripts that exit on their own. process.kill is
// replaced in every test, so supervision (signal 0 probes, SIGTERM, SIGKILL) is
// recorded instead of delivered and no real process ever receives a signal.
type KillCall = [pid: number, signal: string | number | undefined];

function mockKill(t: test.TestContext): KillCall[] {
  const calls: KillCall[] = [];
  t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    calls.push([pid, signal]);
    throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
  });
  return calls;
}

function runner(environment: NodeJS.ProcessEnv = {}): ProcessRunner {
  return new ProcessRunner(new RunnerRegistry([{ id: "node", executable: process.execPath }]), { environment });
}

function spec(script: string, overrides: Partial<RunnerSpec> = {}): RunnerSpec {
  return {
    jobId: "job_unit_process",
    argv: [process.execPath, "-e", script],
    mode: "advise",
    timeoutMs: 30_000,
    ...overrides,
  };
}

function code(expected: string) {
  return (error: unknown) => error instanceof CueLineError && error.code === expected;
}

test("a clean exit succeeds and combines stdout and stderr with one separator", async (t) => {
  mockKill(t);
  const result = await runner().run(spec("process.stdout.write('out'); process.stderr.write('err')"));
  assert.equal(result.status, "succeeded");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "err");
  assert.equal(result.output, "out\nerr");
  assert.equal(result.emptyOutput, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, false);
  assert.equal(result.ambiguousSideEffects, false);
  assert.equal(result.retryable, false);
  assert.equal("stdoutTruncatedChars" in result, false);
  assert.ok(Date.parse(result.finishedAt) >= Date.parse(result.startedAt));
});

test("output joining keeps an existing newline and passes a lone stream through", async (t) => {
  mockKill(t);
  const both = await runner().run(spec("process.stdout.write('out\\n'); process.stderr.write('err')"));
  assert.equal(both.output, "out\nerr");
  const onlyErr = await runner().run(spec("process.stderr.write('err')"));
  assert.equal(onlyErr.output, "err");
  const silent = await runner().run(spec(""));
  assert.equal(silent.output, "");
  assert.equal(silent.emptyOutput, true);
});

test("a non-zero exit fails, and only work mode reports ambiguous side effects", async (t) => {
  mockKill(t);
  const advise = await runner().run(spec("process.exit(3)"));
  assert.equal(advise.status, "failed");
  assert.equal(advise.exitCode, 3);
  assert.equal(advise.ambiguousSideEffects, false);
  const work = await runner().run(spec("process.exit(4)", { mode: "work" }));
  assert.equal(work.status, "failed");
  assert.equal(work.exitCode, 4);
  assert.equal(work.ambiguousSideEffects, true);
});

test("stdin is delivered and the child sees the merged environment with CUELINE_DEPTH=1", async (t) => {
  mockKill(t);
  const script =
    "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);" +
    "process.stdin.on('end',()=>process.stdout.write(JSON.stringify({s,base:process.env.BASE,extra:process.env.EXTRA,depth:process.env.CUELINE_DEPTH})))";
  const cwd = await mkdtemp(path.join(tmpdir(), "cueline-unit-runner-"));
  const result = await runner({ BASE: "from-runner", EXTRA: "overridden" }).run(
    spec(script, { stdin: "héllo\n", env: { EXTRA: "from-spec" }, cwd }),
  );
  assert.equal(result.status, "succeeded");
  assert.deepEqual(JSON.parse(result.stdout), {
    s: "héllo\n",
    base: "from-runner",
    extra: "from-spec",
    depth: "1",
  });
});

test("nested routing is rejected from either the runner or the spec environment", async (t) => {
  const calls = mockKill(t);
  await assert.rejects(runner({ CUELINE_DEPTH: "1" }).run(spec("")), code("NESTED_ROUTING_REJECTED"));
  await assert.rejects(runner().run(spec("", { env: { CUELINE_DEPTH: "" } })), code("NESTED_ROUTING_REJECTED"));
  assert.deepEqual(calls, []);
});

test("timeouts outside the timer range are rejected before spawning", async (t) => {
  mockKill(t);
  let spawned = false;
  for (const timeoutMs of [0, -1, 1.5, Number.NaN, 2 ** 31]) {
    await assert.rejects(
      runner().run(spec("", { timeoutMs }), { onSpawn: () => { spawned = true; } }),
      code("PROCESS_TIMEOUT_INVALID"),
      String(timeoutMs),
    );
  }
  assert.equal(spawned, false);
});

test("argv must start with a registered executable", async (t) => {
  mockKill(t);
  await assert.rejects(runner().run(spec("", { argv: [] })), code("RUNNER_ARGV_INVALID"));
  await assert.rejects(runner().run(spec("", { argv: [""] })), code("RUNNER_ARGV_INVALID"));
  await assert.rejects(runner().run(spec("", { argv: ["node", "-e", ""] })), code("RUNNER_EXECUTABLE_UNREGISTERED"));
});

test("an already-aborted signal returns cancelled without spawning", async (t) => {
  const calls = mockKill(t);
  const controller = new AbortController();
  controller.abort();
  let spawned = false;
  const result = await runner().run(spec("process.exit(9)", { signal: controller.signal, mode: "work" }), {
    onSpawn: () => { spawned = true; },
  });
  assert.equal(spawned, false);
  assert.equal(result.status, "cancelled");
  assert.equal(result.cancelled, true);
  assert.equal(result.exitCode, null);
  assert.equal(result.emptyOutput, true);
  // Nothing ran, so even work mode has no ambiguous side effects.
  assert.equal(result.ambiguousSideEffects, false);
  assert.deepEqual(calls, []);
});

test("large streams keep head and tail and report the exact truncated count", async (t) => {
  mockKill(t);
  const total = 600_000;
  const result = await runner().run(
    spec(`process.stdout.write('A'.repeat(256000) + 'M'.repeat(${total - 512_000}) + 'Z'.repeat(256000))`),
  );
  assert.equal(result.status, "succeeded");
  assert.equal(result.stdoutTruncatedChars, total - 512_000);
  assert.equal("stderrTruncatedChars" in result, false);
  const marker = `\n...[truncated ${total - 512_000} chars]...\n`;
  assert.equal(result.stdout, `${"A".repeat(256_000)}${marker}${"Z".repeat(256_000)}`);
});

test("model and provider headers on stderr are reported once, and unsafe values are dropped", async (t) => {
  mockKill(t);
  const progress: Array<{ phase: string; model?: string; provider?: string }> = [];
  const script =
    "process.stderr.write('Model:  gpt-unit/1.0  \\nprovider: bad value!\\nprovider: unit-provider\\n');" +
    "setTimeout(()=>{process.stderr.write('model: other\\n');process.stdout.write('done')},20)";
  const result = await runner().run(spec(script), {
    onProgress: (event) => {
      progress.push({
        phase: event.phase,
        ...(event.model === undefined ? {} : { model: event.model }),
        ...(event.provider === undefined ? {} : { provider: event.provider }),
      });
      throw new Error("progress sinks cannot break supervision");
    },
  });
  assert.equal(result.status, "succeeded");
  const waiting = progress.filter((event) => event.phase === "waiting_for_model");
  // The unsafe provider line is skipped; the first safe value of each header wins.
  assert.deepEqual(waiting, [{ phase: "waiting_for_model", model: "gpt-unit/1.0", provider: "unit-provider" }]);
  assert.deepEqual(progress.at(-1), { phase: "producing_output", model: "gpt-unit/1.0", provider: "unit-provider" });
});

test("a registered executable that cannot be spawned fails with the spawn error", async (t) => {
  mockKill(t);
  const missing = path.join(await mkdtemp(path.join(tmpdir(), "cueline-unit-runner-missing-")), "absent");
  const result = await new ProcessRunner(new RunnerRegistry([{ id: "absent", executable: missing }]), {
    environment: {},
  }).run({ jobId: "job_unit_missing", argv: [missing], mode: "work", timeoutMs: 30_000 });
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, null);
  assert.match(result.stderr, /ENOENT/);
  assert.equal(result.ambiguousSideEffects, true);
});

test("a timeout signals the process group and settles as timed_out", async (t) => {
  if (process.platform === "win32") return;
  const calls = mockKill(t);
  let pid: number | undefined;
  const result = await runner().run(spec("setTimeout(()=>{},400)", { timeoutMs: 20 }), {
    onSpawn: (spawned) => { pid = spawned; },
  });
  assert.equal(result.status, "timed_out");
  assert.equal(result.timedOut, true);
  assert.equal(result.cancelled, false);
  assert.ok(pid !== undefined);
  const group = -pid;
  assert.deepEqual(calls[0], [group, "SIGTERM"]);
  assert.ok(calls.every(([target]) => target === group));
});

test("aborting after spawn cancels advise jobs and marks work jobs ambiguous", async (t) => {
  if (process.platform === "win32") return;
  const calls = mockKill(t);
  for (const [mode, status] of [["advise", "cancelled"], ["work", "ambiguous"]] as const) {
    const controller = new AbortController();
    const result = await runner().run(spec("setTimeout(()=>{},150)", { mode, signal: controller.signal }), {
      onSpawn: () => controller.abort(),
    });
    assert.equal(result.status, status, mode);
    assert.equal(result.cancelled, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.ambiguousSideEffects, mode === "work");
  }
  assert.ok(calls.some(([, signal]) => signal === "SIGTERM"));
});

test("a failing onSpawn hook cancels the child, waits for it, and rethrows", async (t) => {
  if (process.platform === "win32") return;
  const calls = mockKill(t);
  const failure = new Error("persisting the pid failed");
  let pid: number | undefined;
  await assert.rejects(
    runner().run(spec(""), {
      onSpawn: (spawned) => {
        pid = spawned;
        throw failure;
      },
    }),
    (error: unknown) => error === failure,
  );
  assert.ok(pid !== undefined);
  assert.deepEqual(calls[0], [-pid, "SIGTERM"]);
});
