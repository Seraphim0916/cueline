import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { installSkill, uninstallSkill } from "../../src/cli/skill-links.js";
import { initialRunState, reduceRunState } from "../../src/core/state-machine.js";
import { runPaths } from "../../src/state/paths.js";
import { RunStore } from "../../src/state/store.js";

const [home, operation, code, site] = process.argv.slice(2);
assert.ok(home && (operation === "skill-install" || operation === "skill-uninstall" || operation === "initial-event"));
assert.ok(code === "EACCES" || code === "EIO" || code === "ENOENT");
const failure = () => Object.assign(new Error(`injected ${code}`), { code });
let injected = 0;

async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(target)).map((name) => path.join(entry.name, name)));
    else result.push(entry.name);
  }
  return result.sort();
}

/** Fail the nth call (1-based) on `target`; every other call is the real one. */
function injectNth<F extends (...args: never[]) => Promise<unknown>>(original: F, target: string, nth: number): F {
  let calls = 0;
  return ((...args: Parameters<F>) => {
    if (String(args[0]) === target && ++calls === nth) { injected++; return Promise.reject(failure()); }
    return original(...args);
  }) as F;
}

if (operation === "skill-install" || operation === "skill-uninstall") {
  // The target is absent, so linkMatches' lstat (call 1) is a real ENOENT and pathExists' lstat (call 2)
  // is the existence check under test.
  const environment = { ...process.env, CODEX_HOME: path.join(home, "codex") };
  const target = path.join(home, "codex", "skills", "cueline");
  await mkdir(path.dirname(target), { recursive: true });
  const originalLstat = fs.promises.lstat;
  fs.promises.lstat = injectNth(originalLstat, target, 2);
  syncBuiltinESMExports();
  let message: string | undefined;
  let errorCode: string | undefined;
  try {
    message = operation === "skill-install"
      ? await installSkill(environment, "codex-only")
      : await uninstallSkill(environment, "codex-only");
  } catch (error) { errorCode = (error as NodeJS.ErrnoException).code; }
  finally { fs.promises.lstat = originalLstat; syncBuiltinESMExports(); }
  let linked = false;
  try { linked = (await originalLstat(target)).isSymbolicLink(); } catch { /* absent */ }
  console.log(JSON.stringify({ operation, code, injected, message, errorCode, linked }));
} else {
  assert.ok(site === "marker" || site === "segments" || site === "recovery");
  const runId = "existence-failure-initial";
  const paths = runPaths(home, runId);
  const now = () => new Date("2026-06-01T00:00:00.000Z");
  const options = { home, runId, initialState: initialRunState(runId, "", "caller"), reducer: reduceRunState, now };
  const payload = { request: "existence failure", executor: "caller" };
  let target: string;
  let nth: number;
  if (site === "recovery") {
    // A first event without a creation marker is the one recoverable case; its segments re-check is
    // the second stat of the segments path (the first is the pre-check).
    await RunStore.createWithInitialEvent(options, "run_created", payload);
    await rm(paths.creationMarker);
    target = `${paths.events}.segments`;
    nth = 2;
  } else {
    target = site === "marker" ? paths.creationMarker : `${paths.events}.segments`;
    nth = 1;
  }
  const before = await files(paths.runDir);
  const beforeEvents = await readFile(paths.events, "utf8").catch(() => undefined);
  const originalStat = fs.promises.stat;
  fs.promises.stat = injectNth(originalStat, target, nth) as typeof originalStat;
  syncBuiltinESMExports();
  let created = false;
  let errorCode: string | undefined;
  try { await RunStore.createWithInitialEvent(options, "run_created", payload); created = true; }
  catch (error) { errorCode = (error as NodeJS.ErrnoException).code; }
  finally { fs.promises.stat = originalStat; syncBuiltinESMExports(); }
  const afterEvents = await readFile(paths.events, "utf8").catch(() => undefined);
  console.log(JSON.stringify({ operation, code, site, injected, created, errorCode, before,
    files: await files(paths.runDir), eventsUnchanged: beforeEvents === afterEvents }));
}
