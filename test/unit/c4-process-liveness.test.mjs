import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const sourceRoot = new URL('../../src/', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot)
        && specifier.startsWith('.') && specifier.endsWith('.js')) {
      return nextResolve(specifier.slice(0, -3) + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
});
let processIsAlive, processOrGroupIsAlive;
try {
  ({ processIsAlive, processOrGroupIsAlive } =
    await import('../../src/core/process-liveness.ts'));
} finally {
  hooks.deregister();
}

const pid = 12345;
const originalKill = process.kill;
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

function withProbe(platform, outcomes, run) {
  const calls = [];
  try {
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform });
    process.kill = (target, signal) => {
      assert.equal(signal, 0, 'only signal 0 may be probed');
      calls.push([target, signal]);
      assert.ok(outcomes.has(target), `unexpected PID probe: ${target}`);
      const outcome = outcomes.get(target);
      if (outcome !== true) throw outcome;
      return true;
    };
    run(calls);
  } finally {
    process.kill = originalKill;
    Object.defineProperty(process, 'platform', originalPlatform);
  }
  assert.equal(process.kill, originalKill);
  assert.deepEqual(Object.getOwnPropertyDescriptor(process, 'platform'), originalPlatform);
}

const error = (code) => Object.assign(new Error(code), { code });

test('invalid PIDs never send a signal, for either entry point', () => {
  for (const platform of ['darwin', 'win32']) {
    withProbe(platform, new Map(), (calls) => {
      for (const value of [undefined, 0, -1, -pid, 0.5, 1.5, NaN,
        Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.equal(processIsAlive(value), false, `process PID ${value}`);
        assert.equal(processOrGroupIsAlive(value), false, `group PID ${value}`);
      }
      assert.deepEqual(calls, []);
    });
  }
});

test('process probes distinguish ESRCH from EPERM and unknown failures', () => {
  for (const [outcome, expected] of [
    [true, true], [error('ESRCH'), false], [error('EPERM'), true],
    [error('EACCES'), true], [new Error('unknown'), true], [null, true], ['ESRCH', true],
  ]) {
    withProbe('darwin', new Map([[pid, outcome]]), (calls) => {
      assert.equal(processIsAlive(pid), expected);
      assert.deepEqual(calls, [[pid, 0]]);
    });
  }
});

test('process/group matrix retains surviving or permission-denied groups', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    for (const leader of [true, error('EPERM'), error('ESRCH')]) {
      for (const group of [true, error('EPERM'), error('ESRCH')]) {
        withProbe(platform, new Map([[pid, leader], [-pid, group]]), (calls) => {
          const leaderAlive = leader === true || leader.code === 'EPERM';
          const probeGroup = !leaderAlive && platform !== 'win32';
          const groupAlive = group === true || group.code === 'EPERM';
          assert.equal(processOrGroupIsAlive(pid), leaderAlive || (probeGroup && groupAlive),
            `${platform}: leader=${leader.code ?? 'alive'}, group=${group.code ?? 'alive'}`);
          assert.deepEqual(calls, probeGroup ? [[pid, 0], [-pid, 0]] : [[pid, 0]]);
        });
      }
    }
  }
});
