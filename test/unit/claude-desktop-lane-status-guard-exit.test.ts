import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireClaudeDesktopLaneLock } from "../../src/browser/claude-desktop/lane-lock.js";
import { waitForCueLineLaneContinuation } from "../../src/browser/claude-desktop/lane-status-guard.js";

// M-93: the wait loop must leave on states that can never permit continuation,
// and must not log the same blocked state every poll.

for (const phase of [
  "complete",
  "blocked",
  "cancelled",
  "round_limit_reached",
  "stagnation_detected",
  "cancellation_pending",
]) {
  test(`wait loop returns instead of polling forever when phase is ${phase}`, async () => {
    let loads = 0;
    const result = await waitForCueLineLaneContinuation("run-1", {
      async loadStatus() {
        loads += 1;
        if (loads > 5) throw new Error("wait loop kept polling a state that never continues");
        return { continueAllowed: false, safeNextAction: "manual_review", phase };
      },
      async onBlocked() {},
      async sleep() {},
    });

    assert.equal(result.continueAllowed, false);
    assert.equal(result.phase, phase);
    assert.equal(loads, 1);
  });
}

test("onBlocked fires only when phase or safeNextAction changes", async () => {
  const statuses = [
    { continueAllowed: false, safeNextAction: "execute_caller_jobs", phase: "caller_jobs_pending" },
    { continueAllowed: false, safeNextAction: "execute_caller_jobs", phase: "caller_jobs_pending" },
    { continueAllowed: false, safeNextAction: "execute_caller_jobs", phase: "caller_jobs_pending" },
    { continueAllowed: false, safeNextAction: "continue_caller_work", phase: "caller_work_running" },
    { continueAllowed: true, safeNextAction: "continue", phase: "resume_ready" },
  ];
  const blocked: string[] = [];
  const result = await waitForCueLineLaneContinuation("run-1", {
    async loadStatus() {
      const next = statuses.shift();
      assert.ok(next);
      return next;
    },
    async onBlocked(status) {
      blocked.push(status.phase);
    },
    async sleep() {},
  });

  assert.equal(result.continueAllowed, true);
  assert.deepEqual(blocked, ["caller_jobs_pending", "caller_work_running"]);
});

// One lane daemon per bridge directory.

test("lane lock refuses a second live daemon and takes over from a dead one", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cueline-lane-lock-"));

  const first = await acquireClaudeDesktopLaneLock(root, { pid: 1111, isAlive: () => true });
  await assert.rejects(
    acquireClaudeDesktopLaneLock(root, { pid: 2222, isAlive: (pid: number) => pid === 1111 }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "CLAUDE_DESKTOP_LANE_LOCKED");
      return true;
    },
  );
  await first.release();

  await writeFile(path.join(root, "lane.lock"), JSON.stringify({ pid: 3333 }));
  const taken = await acquireClaudeDesktopLaneLock(root, { pid: 4444, isAlive: () => false });
  assert.equal(JSON.parse(await readFile(path.join(root, "lane.lock"), "utf8")).pid, 4444);
  await taken.release();
});
