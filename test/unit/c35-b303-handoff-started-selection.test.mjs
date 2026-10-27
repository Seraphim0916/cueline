import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import test from 'node:test';

const root = new URL('../../src/', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === root + 'observation/run-handoff.ts') {
      const name = { '../api-runtime-lifecycle.js': 'loadCueLineRunStatus',
        '../core/persisted-run.js': 'loadPersistedRunStore' }[specifier];
      if (name) return nextResolve('data:text/javascript,' + encodeURIComponent(
        `export function ${name}() { throw new Error('unexpected persisted I/O'); }`), context);
    }
    if (context.parentURL?.startsWith(root) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      return nextResolve(specifier.slice(0, -3) + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
});
let buildCueLineRunHandoff, initialRunState, summarizeCueLineRunState;
try {
  ({ buildCueLineRunHandoff } = await import('../../src/observation/run-handoff.ts'));
  ({ initialRunState } = await import('../../src/core/state-machine.ts'));
  ({ summarizeCueLineRunState } = await import('../../src/core/run-status.ts'));
} finally { hooks.deregister(); }

function job(id, status, stage, mode = 'work') {
  return {
    jobId: id, jobKey: id, required: true, status, output: null, error: null,
    spec: { job_key: id, lane: 'default', mode, task: 'inspect only' },
    callerWork: { claim: stage === 'unclaimed' ? null : {
      startedAt: stage === 'started' ? '2026-10-27T00:00:00Z' : null,
    } },
  };
}

function packet(jobs, action, observed = {}) {
  const state = initialRunState('run_c35', 'selection only', 'caller', 12, false);
  state.jobs = Object.fromEntries(jobs.map(job => [job.jobId, job]));
  const status = summarizeCueLineRunState(state, 0, { ownership: 'missing' });
  // Isolate the builder's selection for each supplied safe action; do not execute jobs.
  status.safeNextAction = action;
  for (const item of status.jobs.items) item.status = observed[item.jobId] ?? item.status;
  return buildCueLineRunHandoff(state, status, tmpdir());
}

const actions = [
  ['start_caller_work', 'startCueLineCallerJob', 'job_claimed'],
  ['continue_caller_work', 'heartbeatCueLineCallerJob', 'job_started'],
];
function expected(method, id) {
  return `await ${method}("run_c35", "${id}", claimProof);`;
}

test('mixed stages select the correct job regardless of registration order', () => {
  for (const activeStatus of ['pending', 'running']) {
    const jobs = [
      job('job_done_claimed', 'completed', 'claimed'),
      job('job_done_started', 'completed', 'started'),
      job('job_unclaimed', activeStatus, 'unclaimed'),
      job('job_advice_claimed', activeStatus, 'claimed', 'advise'),
      job('job_advice_started', activeStatus, 'started', 'advise'),
      job('job_claimed', activeStatus, 'claimed'),
      job('job_started', activeStatus, 'started'),
    ];
    for (let offset = 0; offset < jobs.length; offset++) {
      const rotated = [...jobs.slice(offset), ...jobs.slice(0, offset)];
      for (const order of [rotated, [...rotated].reverse()]) {
        for (const [action, method, id] of actions) {
          const value = packet(order, action);
          assert.equal(value.next.action, action);
          assert.equal(value.next.apiExample, expected(method, id));
          const selected = value.jobs.find(job => job.jobId === id);
          assert.equal(selected.claimed, true);
          assert.equal(selected.started, action === 'continue_caller_work');
        }
      }
    }
  }
});

test('absent matching stage uses placeholder, never advice or terminal jobs', () => {
  for (const [action, method] of actions) {
    const opposite = action === 'start_caller_work' ? 'started' : 'claimed';
    for (const jobs of [[], [job('advice', 'pending', 'started', 'advise')], [
      job('done', 'completed', 'started'), job('done_claimed', 'completed', 'claimed'),
      job('unclaimed', 'pending', 'unclaimed'), job('opposite', 'running', opposite),
      job('advice_claimed', 'pending', 'claimed', 'advise'),
    ]]) {
      assert.equal(packet(jobs, action).next.apiExample, expected(method, '<job-id>'));
    }
  }
});

test('observed status excludes a stale active candidate and preserves first eligible ordering', () => {
  for (const [action, method] of actions) {
    const stage = action === 'start_caller_work' ? 'claimed' : 'started';
    const jobs = ['stale', 'first', 'second'].map(id => job(id, 'pending', stage));
    assert.equal(packet(jobs, action, { stale: 'completed' }).next.apiExample, expected(method, 'first'));
    assert.equal(packet([...jobs].reverse(), action, { stale: 'completed' }).next.apiExample, expected(method, 'second'));
  }
});
