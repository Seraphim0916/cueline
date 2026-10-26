import assert from "node:assert/strict";
import test from "node:test";

import { processIsAlive, processOrGroupIsAlive } from "../../src/core/process-liveness.js";

// Every test replaces process.kill, so no signal (not even signal 0) reaches a real process.
function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

type KillCall = [pid: number, signal: string | number | undefined];

function mockKill(
  t: test.TestContext,
  behaviour: (pid: number) => void,
): KillCall[] {
  const calls: KillCall[] = [];
  t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    calls.push([pid, signal]);
    behaviour(pid);
    return true;
  });
  return calls;
}

test("processIsAlive rejects missing, non-integer and non-positive pids without probing", (t) => {
  const calls = mockKill(t, () => undefined);
  for (const pid of [undefined, 0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(processIsAlive(pid), false, `pid ${String(pid)}`);
    assert.equal(processOrGroupIsAlive(pid), false, `group pid ${String(pid)}`);
  }
  assert.deepEqual(calls, []);
});

test("processIsAlive probes with signal 0 and treats a successful probe as alive", (t) => {
  const calls = mockKill(t, () => undefined);
  assert.equal(processIsAlive(1), true);
  assert.equal(processIsAlive(Number.MAX_SAFE_INTEGER), true);
  assert.deepEqual(calls, [[1, 0], [Number.MAX_SAFE_INTEGER, 0]]);
});

test("only ESRCH means gone; permission and unknown errors keep the process alive", (t) => {
  let thrown: unknown;
  mockKill(t, () => {
    throw thrown;
  });
  thrown = errno("ESRCH");
  assert.equal(processIsAlive(42), false);
  for (const value of [errno("EPERM"), errno("EINVAL"), new Error("no code"), "ESRCH", null, { code: 3 }]) {
    thrown = value;
    assert.equal(processIsAlive(42), true, `thrown ${JSON.stringify(value)}`);
  }
});

test("processOrGroupIsAlive returns early when the pid itself is alive", (t) => {
  const calls = mockKill(t, () => undefined);
  assert.equal(processOrGroupIsAlive(7), true);
  assert.deepEqual(calls, [[7, 0]]);
});

test("processOrGroupIsAlive falls back to the negative group id when the leader is gone", (t) => {
  if (process.platform === "win32") {
    t.skip("process groups are not probed on Windows");
    return;
  }
  let groupError: unknown;
  const calls = mockKill(t, (pid) => {
    if (pid > 0) throw errno("ESRCH");
    if (groupError !== undefined) throw groupError;
  });

  groupError = undefined;
  assert.equal(processOrGroupIsAlive(7), true);
  groupError = errno("ESRCH");
  assert.equal(processOrGroupIsAlive(7), false);
  groupError = errno("EPERM");
  assert.equal(processOrGroupIsAlive(7), true);
  assert.deepEqual(calls, [[7, 0], [-7, 0], [7, 0], [-7, 0], [7, 0], [-7, 0]]);
});

test("a missing kill function reports a valid pid as alive rather than guessing it is gone", () => {
  const original = Object.getOwnPropertyDescriptor(process, "kill")!;
  Object.defineProperty(process, "kill", { ...original, value: undefined });
  try {
    assert.equal(processIsAlive(5), true);
    assert.equal(processIsAlive(0), false);
    assert.equal(processOrGroupIsAlive(5), true);
  } finally {
    Object.defineProperty(process, "kill", original);
  }
});
