import assert from 'node:assert/strict';
import test from 'node:test';
import { isLegacyIabDeliveryTimeoutPreClickFailure } from '../../dist/src/core/state-machine.js';

const requestId = 'request-b356';
const conversationUrl = 'https://chatgpt.com/c/conversation-b356';
const valid = {
  code: 'IAB_RECONCILIATION_FAILED', requestId, stage: 'reconciling',
  submissionState: 'possibly_sent', conversationUrl,
  message: 'TypeError: button.click is not a function at __playwrightEvaluate',
};
const eligible = (failure) => isLegacyIabDeliveryTimeoutPreClickFailure(failure, requestId, conversationUrl);

test('both existing button.click error forms qualify', () => {
  for (const article of ['a ', '']) {
    assert.equal(eligible({ ...valid,
      message: `TypeError: button.click is not ${article}function at __playwrightEvaluate`,
    }), true);
  }
});

const invalidFields = [
  ['code', 'CONTROLLER_TIMEOUT'], ['code', null],
  ['requestId', 'another-request'], ['requestId', null],
  ['stage', 'submitting'], ['stage', null],
  ['submissionState', 'definitely_not_sent'], ['submissionState', 'sent'],
  ['submissionState', null],
  ['message', 'TypeError: button.click is not a function'],
  ['message', 'TypeError: button.click timed out at __playwrightEvaluate'],
  ['message', 'TypeError: other.click is not a function at __playwrightEvaluate'],
  ['message', null], ['message', 123],
  ['conversationUrl', 'https://chatgpt.com/c/another-conversation'],
  ['conversationUrl', 'https://example.com/c/conversation-b356'],
  ['conversationUrl', 'not-a-url'], ['conversationUrl', null],
];
for (const [field, value] of invalidFields) {
  test(`reject changed ${field}: ${JSON.stringify(value)}`, () => {
    assert.equal(eligible({ ...valid, [field]: value }), false);
  });
}

test('missing failure and mismatched caller identity are rejected', () => {
  assert.equal(eligible(null), false);
  assert.equal(isLegacyIabDeliveryTimeoutPreClickFailure(valid, 'another-request', conversationUrl), false);
  assert.equal(isLegacyIabDeliveryTimeoutPreClickFailure(valid, requestId,
    'https://chatgpt.com/c/another-conversation'), false);
});

test('legacy gate [true,false,false,false,false,false]', () => {
  const results = [valid, ...[
    ['code', 'CONTROLLER_TIMEOUT'], ['requestId', 'another-request'],
    ['stage', 'submitting'], ['submissionState', 'definitely_not_sent'],
    ['message', 'TypeError: button.click is not a function'],
  ].map(([field, value]) => ({ ...valid, [field]: value }))].map(eligible);
  assert.deepEqual(results, [true, false, false, false, false, false]);
  console.log('legacy gate', results);
});
