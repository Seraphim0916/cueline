import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const sourceRoot = new URL('../../src/', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot) &&
        specifier.startsWith('.') && specifier.endsWith('.js')) {
      return nextResolve(specifier.slice(0, -3) + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
});
let api;
try {
  api = await import('../../src/integrations/goalbraid.ts');
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

test('parent completion prompt and parser follow the same rollup gate', () => {
  const request = fixtureRequest();
  // Toggle the same request in both directions to catch retained eligibility.
  for (const satisfied of [false, true, false]) {
    request.snapshot.rollup_satisfied = satisfied;
    const prompt = api.buildGoalbraidDecisionPrompt(request);
    const legalLine = prompt.split('\n').find(line => line.startsWith('Choose exactly one decision from: '));
    assert.ok(legalLine);
    const legal = legalLine.slice('Choose exactly one decision from: '.length, -1).split(', ');
    assert.deepEqual(legal, [
      'select:目標-a', 'select:goal-b',
      ...(satisfied ? ['parent_done'] : []), 'human_required',
    ]);
    assert.equal(prompt.includes('parent_done'), satisfied);
    for (const decision of ['human_required', 'select:目標-a', 'select:goal-b']) {
      assert.deepEqual(api.parseGoalbraidDecisionDelivery(JSON.stringify({ decision }), request), { decision });
    }
    if (satisfied) {
      assert.deepEqual(api.parseGoalbraidDecisionDelivery('{"decision":"parent_done"}', request),
        { decision: 'parent_done' });
    } else {
      assert.throws(() => api.parseGoalbraidDecisionDelivery('{"decision":"parent_done"}', request),
        { code: 'GOALBRAID_DECISION_OUTSIDE_CLOSED_SET' });
    }
    assert.throws(() => api.parseGoalbraidDecisionDelivery('{"decision":"select:unknown"}', request),
      { code: 'GOALBRAID_DECISION_OUTSIDE_CLOSED_SET' });
    console.log('rollup_satisfied', satisfied, 'prompt parent_done', legal.includes('parent_done'),
      'parser', satisfied ? 'accepted' : 'rejected', 'human and children preserved');
  }
});
