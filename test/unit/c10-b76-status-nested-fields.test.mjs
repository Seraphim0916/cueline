import assert from 'node:assert/strict';
import test from 'node:test';
import { safeCueLineRunStatus } from '../../src/core/run-status-view.ts';

const diagnostic = {
  code: 'CONTROLLER_OBSERVATION_PENDING_STABLE', failedCondition: 'pending',
  stableForMs: 0, thresholdMs: 100, observedUserMessageCount: null,
  baselineUserMessageCount: 0, requestMessageFound: false,
  requestMessageFoundBy: null, assistantTextFoundBy: 'synthetic',
  composerPromptState: null, sourcesConsulted: ['synthetic'],
};
const reconciliation = {
  requiredReason: 'synthetic', operatorConfirmation: null, abandonedRequestId: null,
  retryRequestId: 'msg_test', promptHash: null, resendBlockedReason: null,
};
function view(extra) {
  return safeCueLineRunStatus({ runtime: {}, cancellation: { jobRequests: [] },
    controller: { lastAcceptedJobKeys: [], archive: { enabled: false }, ...extra },
    jobs: { counts: {}, items: [] } }).controller;
}

test('nested status fields preserve every allowed value and omit future fields', () => {
  const result = view({
    pendingDiagnostic: { ...diagnostic, futurePrivateField: 'synthetic-only' },
    reconciliation: { ...reconciliation, futurePrivateField: 'synthetic-only' },
  });
  assert.deepEqual(result.pendingDiagnostic, diagnostic);
  assert.deepEqual(result.reconciliation, reconciliation);
  assert.doesNotMatch(JSON.stringify(result), /futurePrivateField|synthetic-only/);
});

test('existing omission conditions remain unchanged', () => {
  for (const pendingDiagnostic of [undefined, null]) {
    assert.equal(Object.hasOwn(view({ pendingDiagnostic }), 'pendingDiagnostic'), false);
  }
  const empty = Object.fromEntries(Object.keys(reconciliation).map(key => [key, null]));
  for (const value of [undefined, empty, { ...empty, futurePrivateField: 'synthetic-only' }]) {
    assert.equal(Object.hasOwn(view({ reconciliation: value }), 'reconciliation'), false);
  }
  for (const key of Object.keys(empty)) {
    const value = { ...empty, [key]: reconciliation[key] ?? 'synthetic' };
    assert.deepEqual(view({ reconciliation: value }).reconciliation, value);
  }
});
