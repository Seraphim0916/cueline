import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { pruneCueLineRuns } from "../../src/api-run-prune.js";
import { CueLineError } from "../../src/core/errors.js";
import { initialRunState, reduceRunState } from "../../src/core/state-machine.js";
import { runPaths } from "../../src/state/paths.js";
import { RunStore } from "../../src/state/store.js";

const [home, operation, code, site] = process.argv.slice(2);
assert.ok(home && (operation === "prune" || operation === "create"));
assert.ok(code === "EACCES" || code === "EIO" || code === "ENOENT");
process.env.CUELINE_HOME = home;
const runId = "existence-failure";
const paths = runPaths(home, runId);
const now = () => new Date("2026-06-01T00:00:00.000Z");
const options = { home, runId, initialState: initialRunState(runId, "", "caller"), reducer: reduceRunState, now };
const failure = () => Object.assign(new Error(`injected ${code}`), { code });
let injected = 0;

async function files(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [name, bytes] of Object.entries(await files(target))) result[path.join(entry.name, name)] = bytes;
    } else result[entry.name] = (await readFile(target)).toString("base64");
  }
  return result;
}

if (operation === "prune") {
  const store = await RunStore.create(options);
  await store.append("run_created", { request: "existence failure", executor: "caller" });
  await store.append("run_completed", { final_delivery_text: "done" });
  const before = await files(paths.runDir);
  const originalRm = fs.promises.rm;
  const originalAccess = fs.promises.access;
  let deleteAttempts = 0;
  fs.promises.rm = async (...args: Parameters<typeof originalRm>) => {
    if (String(args[0]) === paths.runDir) {
      deleteAttempts++;
      // Reproduce the post-delete fence error. For failure cases, leave all bytes intact.
      if (code === "ENOENT") await originalRm(...args);
      throw new CueLineError("RUNTIME_MUTATION_FENCED", "injected deletion fence");
    }
    return originalRm(...args);
  };
  fs.promises.access = async (...args: Parameters<typeof originalAccess>) => {
    if (String(args[0]) === paths.runDir) { injected++; throw failure(); }
    return originalAccess(...args);
  };
  syncBuiltinESMExports();
  let result;
  try {
    result = await pruneCueLineRuns({ home, apply: true, olderThanMs: 0,
      now: () => new Date("2026-07-01T00:00:00.000Z") });
  } finally {
    fs.promises.rm = originalRm;
    fs.promises.access = originalAccess;
    syncBuiltinESMExports();
  }
  const remaining = await readdir(path.dirname(paths.runDir));
  console.log(JSON.stringify({ operation, code, injected, deleteAttempts, result,
    present: remaining.includes(runId), unchanged: code !== "ENOENT" &&
      JSON.stringify(await files(paths.runDir)) === JSON.stringify(before) }));
} else {
  assert.ok(site === "segments" || site === "marker");
  const target = site === "segments" ? `${paths.events}.segments` : paths.creationMarker;
  const originalStat = fs.promises.stat;
  // Preserve stat's overloads; delegation retains all non-target behaviour.
  fs.promises.stat = ((...args: Parameters<typeof originalStat>) => {
    if (String(args[0]) === target) { injected++; return Promise.reject(failure()); }
    return originalStat(...args);
  }) as typeof originalStat;
  syncBuiltinESMExports();
  let errorCode: string | undefined;
  let created = false;
  try { await RunStore.create(options); created = true; }
  catch (error) { errorCode = (error as NodeJS.ErrnoException).code; }
  finally { fs.promises.stat = originalStat; syncBuiltinESMExports(); }
  console.log(JSON.stringify({ operation, code, site, injected, created, errorCode,
    files: Object.keys(await files(paths.runDir)) }));
}
