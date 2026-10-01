import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { JobStatusStore } from "../../src/jobs/status.js";

// IPC releases independent runtimes together; all durable writes use the real
// filesystem. No provider, browser, or user process participates in this race.
const childSource = `
  const { JobStatusStore } = await import(${JSON.stringify(new URL("../../src/jobs/status.js", import.meta.url).href)});
  const [home, status] = process.argv.slice(1);
  const go = new Promise(resolve => process.once("message", resolve));
  process.send("ready");
  await go;
  try {
    await new JobStatusStore(home).write({
      jobId: "process-race", execution: "foreground", status,
      startedAt: "2026-07-22T00:00:00.000Z",
      ...(status === "running" ? {} : { finishedAt: "2026-07-22T00:00:01.000Z" }),
    });
    console.log(JSON.stringify({ status, outcome: "written" }));
  } catch (error) {
    if (typeof error.code !== "string") throw error;
    console.log(JSON.stringify({ status, errorCode: error.code }));
  }
  process.disconnect();
`;

test("independent processes preserve one terminal winner against conflicting and stale writes", { timeout: 15_000 }, async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-process-terminal-race-"));
  const writers = ["succeeded", "ambiguous", "running"].map((status) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childSource, home, status], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (data) => { stdout += String(data); });
    child.stderr!.on("data", (data) => { stderr += String(data); });
    let readyResolve!: () => void;
    const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
    child.once("message", (message) => { if (message === "ready") readyResolve(); });
    // An early spawn/exit error also releases readiness so the result assertion
    // fails promptly, without hanging the barrier or leaking the other writers.
    child.once("error", readyResolve);
    const done = new Promise<Record<string, string>>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        readyResolve();
        try {
          assert.equal(code, 0, `${status}: ${stderr}; signal=${signal}`);
          resolve(JSON.parse(stdout));
        } catch (error) { reject(error); }
      });
    });
    return { child, ready, done };
  });
  const results = Promise.all(writers.map(({ done }) => done));
  // Attach rejection handling before waiting for the start barrier.
  const completed = await Promise.all([
    results,
    (async () => {
      await Promise.all(writers.map(({ ready }) => ready));
      for (const { child } of writers) if (child.connected) child.send("go");
    })(),
  ]);
  const terminals = completed[0].filter((result) => result.status !== "running");
  assert.equal(terminals.filter((result) => result.outcome === "written").length, 1);
  assert.equal(terminals.filter((result) => result.errorCode === "JOB_STATUS_TERMINAL_CONFLICT").length, 1);
  const running = completed[0].find((result) => result.status === "running")!;
  assert.ok(running.outcome === "written" || running.errorCode === "JOB_STATUS_ALREADY_TERMINAL");
  const store = new JobStatusStore(home);
  const winner = await store.read("process-race");
  assert.equal(winner?.status, terminals.find((result) => result.outcome === "written")?.status);
  assert.deepEqual(JSON.parse(await readFile(store.pathFor("process-race"), "utf8")), winner);
  assert.deepEqual(JSON.parse(await readFile(store.terminalPathFor("process-race"), "utf8")), winner);
  assert.deepEqual((await readdir(path.join(home, "jobs"))).sort(), ["process-race.json", "process-race.terminal"]);
});

test("a paused stale process cannot hide a terminal anchor while replacing canonical status", { timeout: 15_000 }, async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-paused-terminal-race-"));
  const source = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const home = process.argv[1];
    const originalRename = fs.promises.rename;
    let intercepted = false;
    async function checkpoint(name) {
      const resume = new Promise(resolve => process.once("message", resolve));
      process.send(name);
      await resume;
    }
    fs.promises.rename = async function(from, to) {
      if (!intercepted && String(to).endsWith("paused-race.json")) {
        intercepted = true;
        await checkpoint("before-rename");
        await originalRename(from, to);
        await checkpoint("after-rename");
        return;
      }
      return originalRename(from, to);
    };
    syncBuiltinESMExports();
    const { JobStatusStore } = await import(${JSON.stringify(new URL("../../src/jobs/status.js", import.meta.url).href)});
    try {
      await new JobStatusStore(home).write({
        jobId: "paused-race", execution: "foreground", status: "running",
        startedAt: "2026-07-22T00:00:00.000Z",
      });
      throw new Error("stale running write unexpectedly succeeded");
    } catch (error) {
      if (error.code !== "JOB_STATUS_ALREADY_TERMINAL") throw error;
      console.log(error.code);
    }
    process.disconnect();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, home], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (data) => { stdout += String(data); });
  child.stderr!.on("data", (data) => { stderr += String(data); });
  let beforeResolve!: () => void;
  let afterResolve!: () => void;
  let phase = "starting";
  const before = new Promise<void>((resolve) => { beforeResolve = resolve; });
  const after = new Promise<void>((resolve) => { afterResolve = resolve; });
  child.on("message", (message) => {
    phase = String(message);
    if (message === "before-rename") beforeResolve();
    if (message === "after-rename") afterResolve();
  });
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", (error) => { beforeResolve(); afterResolve(); reject(error); });
    child.once("close", (code, signal) => {
      beforeResolve(); afterResolve();
      try {
        assert.equal(code, 0, `${stderr}; signal=${signal}`);
        assert.equal(stdout.trim(), "JOB_STATUS_ALREADY_TERMINAL");
        resolve();
      } catch (error) { reject(error); }
    });
  });
  const store = new JobStatusStore(home);
  const terminal = {
    jobId: "paused-race", execution: "foreground" as const, status: "succeeded" as const,
    startedAt: "2026-07-22T00:00:00.000Z", finishedAt: "2026-07-22T00:00:01.000Z",
  };
  await Promise.all([done, (async () => {
    await before;
    assert.equal(phase, "before-rename");
    await store.write(terminal);
    child.send("resume-rename");
    await after;
    assert.equal(phase, "after-rename");
    assert.equal(JSON.parse(await readFile(store.pathFor("paused-race"), "utf8")).status, "running");
    assert.deepEqual(await store.read("paused-race"), terminal);
    child.send("resume-repair");
  })()]);
  assert.deepEqual(JSON.parse(await readFile(store.pathFor("paused-race"), "utf8")), terminal);
  assert.deepEqual(JSON.parse(await readFile(store.terminalPathFor("paused-race"), "utf8")), terminal);
  assert.deepEqual((await readdir(path.join(home, "jobs"))).sort(), ["paused-race.json", "paused-race.terminal"]);
});
