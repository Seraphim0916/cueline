import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import test, { after } from 'node:test';

const key = Symbol.for('c35-b302-loaders');
const root = new URL('../../src/', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === root + 'observation/run-handoff.ts') {
      const name = { '../api-runtime-lifecycle.js': 'loadCueLineRunStatus',
        '../core/persisted-run.js': 'loadPersistedRunStore' }[specifier];
      if (name) return nextResolve('data:text/javascript,' + encodeURIComponent(
        `export async function ${name}(...args) { return globalThis[Symbol.for('c35-b302-loaders')].${name}(...args); }`), context);
    }
    if (context.parentURL?.startsWith(root) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      return nextResolve(specifier.slice(0, -3) + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
});
let createCueLineRunHandoff, initialRunState, summarizeCueLineRunState;
try {
  ({ createCueLineRunHandoff } = await import('../../src/observation/run-handoff.ts'));
  ({ initialRunState } = await import('../../src/core/state-machine.ts'));
  ({ summarizeCueLineRunState } = await import('../../src/core/run-status.ts'));
} finally { hooks.deregister(); }
after(() => { delete globalThis[key]; });

function setup(sequences, failure) {
  const calls = [];
  const home = tmpdir();
  const now = () => new Date('2026-10-27T00:00:00Z');
  let loads = 0, statuses = 0;
  globalThis[key] = {
    async loadPersistedRunStore(actualHome, runId) {
      calls.push(`store:${++loads}`);
      assert.equal(actualHome, home);
      assert.equal(runId, 'run_c35');
      if (failure?.at === `store:${loads}`) throw failure.error;
      assert.ok(loads <= sequences.length, 'unexpected extra store read');
      const state = initialRunState(runId, `request round ${loads}`, 'caller', 12, false);
      state.round = loads;
      return { state, lastSequence: sequences[loads - 1][0] };
    },
    async loadCueLineRunStatus(runId, options) {
      calls.push(`status:${++statuses}`);
      assert.equal(runId, 'run_c35');
      assert.equal(options.home, home);
      assert.equal(options.now, now);
      if (failure?.at === `status:${statuses}`) throw failure.error;
      assert.ok(statuses <= sequences.length, 'unexpected extra status read');
      const state = initialRunState(runId, '', 'caller', 12, false);
      const status = summarizeCueLineRunState(state, sequences[statuses - 1][1], { ownership: 'missing' });
      status.safeNextAction = statuses === 1 ? 'observe' : 'return_result';
      return status;
    },
  };
  return { calls, options: { home, now, includeContent: true } };
}

test('one race retries in order and returns both state and status from round two', async () => {
  const { calls, options } = setup([[1, 2], [3, 3]]);
  const packet = await createCueLineRunHandoff('run_c35', options);
  assert.deepEqual(calls, ['store:1', 'status:1', 'store:2', 'status:2']);
  assert.equal(packet.content.request, 'request round 2');
  assert.equal(packet.run.round, 2);
  assert.equal(packet.run.eventSequence, 3);
  assert.equal(packet.next.action, 'return_result');
  assert.equal(packet.generatedAt, '2026-10-27T00:00:00.000Z');
});

test('two races stop after exactly two rounds with the established error', async () => {
  const { calls, options } = setup([[1, 2], [3, 4]]);
  await assert.rejects(createCueLineRunHandoff('run_c35', options), error => {
    assert.equal(error.code, 'RUN_HANDOFF_SNAPSHOT_CHANGED');
    assert.equal(error.message, "Run 'run_c35' changed while its handoff packet was being read; retry the read-only command.");
    return true;
  });
  assert.deepEqual(calls, ['store:1', 'status:1', 'store:2', 'status:2']);
});

test('consistent first round does not perform a second read', async () => {
  const { calls, options } = setup([[7, 7]]);
  const packet = await createCueLineRunHandoff('run_c35', options);
  assert.equal(packet.content.request, 'request round 1');
  assert.equal(packet.run.eventSequence, 7);
  assert.deepEqual(calls, ['store:1', 'status:1']);
});

for (const [index, at] of ['store:1', 'status:1', 'store:2', 'status:2'].entries()) {
  test(`${at} failure is propagated by identity without further reads`, async () => {
    const error = new Error(`read failed at ${at}`);
    const { calls, options } = setup([[1, 2], [3, 3]], { at, error });
    await assert.rejects(createCueLineRunHandoff('run_c35', options), actual => actual === error);
    assert.deepEqual(calls, ['store:1', 'status:1', 'store:2', 'status:2'].slice(0, index + 1));
  });
}
