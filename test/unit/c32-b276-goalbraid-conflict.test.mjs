import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Replace only storage boundaries; execute the unchanged public source functions.
const storageUrl = 'data:text/javascript,' + encodeURIComponent(`
  export const files = new Map();
  export async function readFile(file, encoding) {
    if (encoding !== 'utf8' || !files.has(file)) throw new Error('unexpected read: ' + file);
    return files.get(file);
  }
  export async function atomicCreateJson(file, value) {
    if (files.has(file)) return false;
    files.set(file, JSON.stringify(value));
    return true;
  }
`);
const { files } = await import(storageUrl);
const sourceRoot = new URL('../../src/', import.meta.url).href;
const goalbraidUrl = new URL('../../src/integrations/goalbraid.ts', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === goalbraidUrl &&
        (specifier === 'node:fs/promises' || specifier === '../state/atomic-write.js')) {
      return { url: storageUrl, shortCircuit: true };
    }
    if (context.parentURL?.startsWith(sourceRoot) &&
        specifier.startsWith('.') && specifier.endsWith('.js')) {
      return nextResolve(specifier.slice(0, -3) + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
});
let api;
try {
  api = await import(goalbraidUrl);
} finally {
  hooks.deregister();
}

function fixtureRequest() {
  return {
    schema: 'goalbraid-cueline-decision-request/v1',
    request_id: 'gbd-a5d7e51a050e63fdb3e6cf3dee07071c',
    request_digest: 'sha256:a5d7e51a050e63fdb3e6cf3dee07071c4a6c9044d566006d483ec6c61956a38e',
    campaign_id: 'fixture-專案',
    created_at: '2026-07-22T00:00:00+00:00',
    authority: {
      decision_controller: 'cueline', executor: 'omnilane',
      completion_authority: 'goalbraid', advisory_only: true,
    },
    snapshot: {
      schema: 'goalbraid-turning-point/v1',
      runnable_children: [
        { goal_id: '目標-a', run_id: 'run-a', priority: 2, depends_on: [] },
        { goal_id: 'goal-b', run_id: 'run-b', priority: 1, depends_on: [] },
      ],
      rollup_satisfied: false,
      gate: { value_gate_enabled: true, serial_single_holder: true },
    },
    response_schema: 'goalbraid-cueline-decision-response/v1',
  };
}

function fixtureResult(request) {
  return {
    runId: 'c32-run', status: 'complete', finalDeliveryText: '{"decision":"select:goal-b"}',
    state: {
      runId: 'c32-run', request: api.buildGoalbraidDecisionPrompt(request),
      executor: 'caller', allowProcessExecution: false,
    },
  };
}

test('immutable publication rejects changed evidence and ignores only creation time', async () => {
  const request = fixtureRequest();
  const requestPath = path.join(tmpdir(), 'c32-b276', 'requests', request.request_id + '.json');
  files.set(requestPath, JSON.stringify(request));
  const result = fixtureResult(request);
  const publish = (candidate, date = '2026-07-23T00:00:00Z') =>
    api.publishGoalbraidDecisionResponse(requestPath, candidate, { outcome: 'verified' },
      { now: () => new Date(date) });
  const first = await publish(result);
  assert.equal(first.outcome, 'published');
  const saved = files.get(first.responsePath);
  assert.deepEqual(JSON.parse(saved), first.response);
  console.log('first', first.outcome);

  const repeated = await publish(result, '2026-07-24T00:00:00Z');
  assert.equal(repeated.outcome, 'already_published');
  assert.deepEqual(repeated.response, first.response);
  assert.equal(files.get(first.responsePath), saved);
  console.log('created_at only', repeated.outcome, 'saved unchanged', true);

  for (const [name, candidate] of [
    ['JSON whitespace', { ...result, finalDeliveryText: '{ "decision": "select:goal-b" }' }],
    ['run identifier', { ...result, runId: 'other-run', state: { ...result.state, runId: 'other-run' } }],
    ['decision', { ...result, finalDeliveryText: '{"decision":"human_required"}' }],
  ]) {
    // Each candidate is otherwise valid, so a conflict must come from stored evidence.
    assert.doesNotThrow(() => api.assertGoalbraidDecisionRunBinding(request, candidate));
    assert.doesNotThrow(() => api.parseGoalbraidDecisionDelivery(candidate.finalDeliveryText, request));
    await assert.rejects(publish(candidate), { code: 'GOALBRAID_DECISION_RESPONSE_CONFLICT' });
    assert.equal(files.get(first.responsePath), saved);
    console.log(name, 'GOALBRAID_DECISION_RESPONSE_CONFLICT', 'saved unchanged', true);
  }

  // Every remaining stable field in existing evidence must also remain immutable.
  for (const [name, mutate] of [
    ['schema', response => { response.schema = 'other-schema'; }],
    ['request_id', response => { response.request_id = 'gbd-other'; }],
    ['request_digest', response => { response.request_digest = 'sha256:other'; }],
    ['controller', response => { response.controller = 'other-controller'; }],
    ['advisory_only', response => { response.advisory_only = false; }],
    ['completion_authority', response => { response.completion_authority = 'cueline'; }],
    ['status', response => { response.cueline.status = 'blocked'; }],
    ['verification', response => { response.cueline.verification = 'degraded'; }],
  ]) {
    const existing = JSON.parse(saved);
    mutate(existing);
    const prior = JSON.stringify(existing);
    files.set(first.responsePath, prior);
    await assert.rejects(publish(result), { code: 'GOALBRAID_DECISION_RESPONSE_CONFLICT' });
    assert.equal(files.get(first.responsePath), prior, name + ' must not be overwritten');
    console.log(name, 'GOALBRAID_DECISION_RESPONSE_CONFLICT', 'saved unchanged', true);
  }
});
