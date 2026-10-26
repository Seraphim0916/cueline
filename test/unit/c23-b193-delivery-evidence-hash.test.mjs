import assert from 'node:assert/strict';
import test from 'node:test';
import { deliveryTimeoutEvidenceHash as hash } from '../../dist/src/browser/delivery-timeout.js';

const evidence = {
  conversationUrl: 'https://chatgpt.com/c/original',
  selectedModelLabel: 'Pro',
  hydrated: true,
  baselineUserMessageCount: 2,
  observedUserMessageCount: 2,
  requestMessageFound: false,
  isAnswering: false,
};
const defaults = {
  observationBaselineUserMessageCount: null,
  assistantMessageCount: null,
  countRegressionDetected: false,
  requestMessageFoundBy: null,
  requestMessageScanComplete: false,
  lastMessageRole: null,
  composerPromptState: null,
  composerAttachmentCount: null,
  composerPastedTextAttachmentPresent: false,
  composerSendButtonEnabled: null,
  deliveryFailure: null,
};
const failure = {
  code: 'CHATGPT_MESSAGE_DELIVERY_TIMEOUT',
  message: 'Message delivery timed out. Please try again.',
  assistantTextHash: 'original-proof',
  retryActionAvailable: true,
};

test('waiting diagnostics do not change delivery evidence identity', () => {
  const pendingDiagnostic = {
    code: 'CONTROLLER_OBSERVATION_PENDING_STABLE',
    failedCondition: 'request_not_found',
    stableForMs: 1000,
    thresholdMs: 5000,
    observedUserMessageCount: 2,
    baselineUserMessageCount: 2,
    requestMessageFound: false,
    requestMessageFoundBy: null,
    assistantTextFoundBy: null,
    composerPromptState: null,
    sourcesConsulted: ['dom'],
  };
  const initial = hash({ ...evidence, pendingDiagnostic });
  const later = hash({ ...evidence, pendingDiagnostic: {
    ...pendingDiagnostic, stableForMs: 9000, thresholdMs: 10000,
    failedCondition: 'still_waiting', sourcesConsulted: ['dom', 'accessibility'],
  } });
  assert.equal(initial, hash(evidence));
  assert.equal(later, initial);
  console.log('volatile_equal', later === initial);
});

test('omitted optional fields equal each explicit default and all defaults', () => {
  for (const [field, value] of Object.entries(defaults)) {
    assert.equal(hash({ ...evidence, [field]: value }), hash(evidence), field);
  }
  assert.equal(hash({ ...evidence, ...defaults }), hash(evidence));
  console.log('default_equal', hash({ ...evidence, ...defaults }) === hash(evidence));
});

test('every included evidence field changes identity independently', () => {
  const changes = {
    conversationUrl: 'https://chatgpt.com/c/other', selectedModelLabel: 'Pro Extended',
    hydrated: false, baselineUserMessageCount: 3,
    observationBaselineUserMessageCount: 2, observedUserMessageCount: 3,
    assistantMessageCount: 1, countRegressionDetected: true,
    requestMessageFound: true, requestMessageFoundBy: 'request_id_scan',
    requestMessageScanComplete: true, isAnswering: true, lastMessageRole: 'user',
    composerPromptState: 'empty', composerAttachmentCount: 0,
    composerPastedTextAttachmentPresent: true, composerSendButtonEnabled: false,
    deliveryFailure: failure,
  };
  for (const [field, value] of Object.entries(changes)) {
    assert.notEqual(hash({ ...evidence, [field]: value }), hash(evidence), field);
  }
  const withFailure = { ...evidence, deliveryFailure: failure };
  for (const [field, value] of Object.entries({ assistantTextHash: 'other-proof', retryActionAvailable: false })) {
    assert.notEqual(hash({ ...withFailure, deliveryFailure: { ...failure, [field]: value } }), hash(withFailure), field);
  }
  console.log('identity_changed', hash({ ...evidence, conversationUrl: changes.conversationUrl }) !== hash(evidence));
});
