import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { initialRunState, reduceRunState } from "../../src/core/state-machine.js";
import { CueLineError } from "../../src/core/errors.js";
import { JobStatusStore } from "../../src/jobs/status.js";
import { requestJobCancellation } from "../../src/state/cancellation.js";
import { runPaths } from "../../src/state/paths.js";
import { RuntimeLease } from "../../src/state/runtime-lease.js";
import { ensurePrivateDirectory } from "../../src/state/private-directory.js";
import { RunStore } from "../../src/state/store.js";

function permissions(mode: number): number {
  return mode & 0o777;
}

async function assertMode(target: string, expected: number): Promise<void> {
  assert.equal(permissions((await stat(target)).mode), expected, target);
}

test(
  "durable run and job evidence stays owner-only even when directories preexist permissively",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cueline-private-state-"));
    const home = path.join(root, "state");
    const runId = "run_private_state";
    const paths = runPaths(home, runId);
    const jobsDirectory = path.join(home, "jobs");
    await mkdir(paths.runDir, { recursive: true, mode: 0o755 });
    await mkdir(jobsDirectory, { recursive: true, mode: 0o755 });
    await chmod(paths.runsDir, 0o755);
    await chmod(paths.runDir, 0o755);
    await chmod(jobsDirectory, 0o755);
    await writeFile(paths.snapshot, "{}\n", { mode: 0o644 });
    await writeFile(
      path.join(jobsDirectory, "job_private_state.json"),
      `${JSON.stringify({
        jobId: "job_private_state",
        runId,
        execution: "foreground",
        status: "pending",
        startedAt: "2026-07-15T00:00:00.000Z",
      })}\n`,
      { mode: 0o644 },
    );
    await chmod(paths.snapshot, 0o644);
    await chmod(path.join(jobsDirectory, "job_private_state.json"), 0o644);

    const previousUmask = process.umask(0o022);
    try {
      const store = await RunStore.createWithInitialEvent(
        {
          home,
          runId,
          initialState: initialRunState(runId, ""),
          reducer: reduceRunState,
        },
        "run_created",
        { request: "private state fixture" },
      );
      const lease = await RuntimeLease.claim({
        home,
        runId,
        heartbeatIntervalMs: 60_000,
      });
      store.bindRuntimeOwner(lease.ownerId);
      await store.append("notice", { message: "private segment fixture" });
      await store.snapshot();
      await lease.release();

      const statusStore = new JobStatusStore(home);
      await statusStore.write({
        jobId: "job_private_state",
        runId,
        execution: "foreground",
        status: "succeeded",
        startedAt: "2026-07-15T00:00:00.000Z",
        finishedAt: "2026-07-15T00:00:01.000Z",
      });
      await requestJobCancellation(
        home,
        runId,
        "job_private_state",
        "private cancellation fixture",
      );
    } finally {
      process.umask(previousUmask);
    }

    const eventDirectory = `${paths.events}.segments`;
    const eventFiles = await readdir(eventDirectory);
    assert.ok(eventFiles.length > 0);
    await assertMode(paths.runsDir, 0o700);
    await assertMode(paths.runDir, 0o700);
    await assertMode(eventDirectory, 0o700);
    for (const eventFile of eventFiles) {
      await assertMode(path.join(eventDirectory, eventFile), 0o600);
    }
    await assertMode(paths.snapshot, 0o600);
    await assertMode(jobsDirectory, 0o700);
    await assertMode(new JobStatusStore(home).pathFor("job_private_state"), 0o600);
    await assertMode(paths.jobCancellationsDir, 0o700);
    await assertMode(path.join(paths.jobCancellationsDir, "job_private_state.json"), 0o600);
    await assertMode(`${paths.runtimeLease}.epochs`, 0o700);
    await assertMode(`${paths.runtimeLease}.fence`, 0o600);
  },
);

test(
  "private state directory hardening refuses a symlink instead of chmodding its target",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cueline-private-symlink-"));
    const home = path.join(root, "state");
    const outside = path.join(root, "outside");
    await mkdir(home);
    await mkdir(outside, { mode: 0o755 });
    await chmod(outside, 0o755);
    await symlink(outside, path.join(home, "jobs"), "dir");

    await assert.rejects(
      new JobStatusStore(home).write({
        jobId: "job_symlink_refused",
        execution: "foreground",
        status: "pending",
        startedAt: "2026-07-15T00:00:00.000Z",
      }),
      (error: unknown) =>
        error instanceof CueLineError && error.code === "PRIVATE_STATE_DIRECTORY_INVALID",
    );

    await assertMode(outside, 0o755);
    await assert.rejects(access(path.join(outside, "job_symlink_refused.json")));
  },
);

test("private state directory hardening reports a stable error for a file path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cueline-private-file-"));
  const blocked = path.join(root, "not-a-directory");
  await writeFile(blocked, "KEEP_ME\n", "utf8");

  await assert.rejects(
    ensurePrivateDirectory(blocked),
    (error: unknown) =>
      error instanceof CueLineError && error.code === "PRIVATE_STATE_DIRECTORY_INVALID",
  );
  assert.equal(await readFile(blocked, "utf8"), "KEEP_ME\n");
});
