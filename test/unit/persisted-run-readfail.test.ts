import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { loadPersistedRunState, loadPersistedRunStore } from "../../src/core/persisted-run.js";
import { initialRunState, reduceRunState } from "../../src/core/state-machine.js";
import { runPaths } from "../../src/state/paths.js";
import { RunStore } from "../../src/state/store.js";

const runId = "run_readfail";

// Root bypasses file permission bits, so a mode-000 event log stays readable
// there; the non-root CI runners still execute these cases.
const permissionDenialUnavailable =
  process.platform === "win32"
    ? "POSIX file permission bits do not deny reads on Windows"
    : process.getuid?.() === 0
      ? "running as root bypasses file permission bits, so reads cannot fail with EACCES"
      : false;

function storeOptions(home: string) {
  return {
    home,
    runId,
    initialState: initialRunState(runId, ""),
    reducer: reduceRunState,
  };
}

async function persistedRun(t: TestContext, { segmented }: { segmented: boolean }) {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-run-readfail-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = await RunStore.createWithInitialEvent(storeOptions(home), "run_created", {
    request: "inspect the repository",
  });
  // The first append moves the log to segments and fences the legacy prefix.
  if (segmented) await store.append("note", { text: "segmented append" });
  const paths = runPaths(home, runId);
  assert.equal((await loadPersistedRunState(home, runId)).request, "inspect the repository");
  return { home, paths };
}

async function runFiles(runDir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else files.set(path.relative(runDir, target), await readFile(target, "utf8"));
    }
  }
  await walk(runDir);
  return files;
}

async function assertRefusedUnchanged(
  home: string,
  runDir: string,
  expected: RegExp | { code: string },
): Promise<void> {
  const before = await runFiles(runDir);
  await assert.rejects(loadPersistedRunStore(home, runId), (error: unknown) => {
    assert.notEqual((error as { code?: unknown }).code, "RUN_NOT_FOUND");
    if (expected instanceof RegExp) assert.match(String(error), expected);
    else assert.equal((error as { code?: unknown }).code, expected.code);
    return true;
  });
  await assertCreateRefused(home);
  assert.deepEqual(await runFiles(runDir), before);
}

async function assertCreateRefused(home: string): Promise<void> {
  await assert.rejects(RunStore.create(storeOptions(home)));
  await assert.rejects(
    RunStore.createWithInitialEvent(storeOptions(home), "run_created", { request: "replacement" }),
  );
}

test("an absent run is reported as not found", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-run-readfail-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  await assert.rejects(loadPersistedRunStore(home, runId), { code: "RUN_NOT_FOUND" });
});

test("a non-JSON legacy event line is refused, not treated as an absent run", async (t) => {
  const { home, paths } = await persistedRun(t, { segmented: false });
  await writeFile(paths.events, `${await readFile(paths.events, "utf8")}{truncated\n`);

  await assertRefusedUnchanged(home, paths.runDir, /EVENT_LOG_INVALID: invalid JSON at line 2/);
});

test("an out-of-sequence legacy event is refused, not replayed", async (t) => {
  const { home, paths } = await persistedRun(t, { segmented: false });
  const first = JSON.parse((await readFile(paths.events, "utf8")).trim()) as object;
  await writeFile(paths.events, `${JSON.stringify({ ...first, sequence: 7 })}\n`);

  await assertRefusedUnchanged(home, paths.runDir, /EVENT_LOG_INVALID: malformed event 1/);
});

test("a tampered or truncated fenced legacy prefix is refused, not replayed", async (t) => {
  const { home, paths } = await persistedRun(t, { segmented: true });
  const original = await readFile(paths.events, "utf8");
  await writeFile(paths.events, original.replace("inspect the repository", "replace the repository"));

  await assertRefusedUnchanged(home, paths.runDir, /EVENT_LOG_INVALID: fenced legacy prefix hash mismatch/);

  await writeFile(paths.events, original.slice(0, -2));
  await assertRefusedUnchanged(home, paths.runDir, /EVENT_LOG_INVALID: fenced legacy prefix was truncated/);
});

test("a corrupt event segment is refused, not skipped", async (t) => {
  const { home, paths } = await persistedRun(t, { segmented: true });
  const segments = `${paths.events}.segments`;
  const [segment] = (await readdir(segments)).filter((name) => /^\d+\.json$/.test(name));
  assert.ok(segment);
  await writeFile(path.join(segments, segment), "{corrupt");

  await assertRefusedUnchanged(home, paths.runDir, /EVENT_LOG_INVALID: invalid event segment/);
});

test("a corrupt legacy segment fence is refused", async (t) => {
  const { home, paths } = await persistedRun(t, { segmented: true });
  await writeFile(path.join(`${paths.events}.segments`, "legacy-fence.json"), "{corrupt");

  await assertRefusedUnchanged(home, paths.runDir, /EVENT_LOG_INVALID: invalid segment fence JSON/);
});

test("an event log that cannot be read as a file is refused, not treated as empty", async (t) => {
  const { home, paths } = await persistedRun(t, { segmented: true });
  await rm(paths.events);
  await mkdir(paths.events);

  await assertRefusedUnchanged(home, paths.runDir, { code: "EISDIR" });
});

test(
  "a permission-denied event log is refused, not treated as an absent run",
  { skip: permissionDenialUnavailable },
  async (t) => {
    const { home, paths } = await persistedRun(t, { segmented: true });
    t.after(() => chmod(paths.events, 0o600).catch(() => undefined));
    const original = await readFile(paths.events, "utf8");
    await chmod(paths.events, 0o000);

    await assert.rejects(loadPersistedRunStore(home, runId), { code: "EACCES" });
    await assertCreateRefused(home);

    await chmod(paths.events, 0o600);
    assert.equal(await readFile(paths.events, "utf8"), original);
  },
);

test("a corrupt legacy log without a creation marker is never re-created over", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "cueline-run-readfail-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = runPaths(home, runId);
  await mkdir(paths.runDir, { recursive: true });
  await writeFile(paths.events, "{truncated\n");

  await assert.rejects(RunStore.create(storeOptions(home)), /EVENT_LOG_INVALID/);
  await assert.rejects(
    RunStore.createWithInitialEvent(storeOptions(home), "run_created", { request: "replacement" }),
    /EVENT_LOG_INVALID/,
  );
  await assert.rejects(loadPersistedRunStore(home, runId), /EVENT_LOG_INVALID/);
  assert.deepEqual([...(await runFiles(paths.runDir)).entries()], [["events.jsonl", "{truncated\n"]]);
});
