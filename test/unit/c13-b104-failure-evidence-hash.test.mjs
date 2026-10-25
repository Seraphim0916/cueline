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
let hash;
try {
  ({ controllerResponseFailureEvidenceHash: hash } = await import('../../src/browser/controller-response-failure.ts'));
} finally {
  hooks.deregister();
}

const required = {
  conversationUrl: 'https://chatgpt.com/c/hash-test',
  selectedModelLabel: 'Pro', hydrated: true,
  baselineUserMessageCount: 2, observedUserMessageCount: 3,
  requestMessageFound: true, isAnswering: false,
};
const defaults = {
  observationBaselineUserMessageCount: null, assistantMessageCount: null,
  countRegressionDetected: false, requestMessageFoundBy: null,
  requestMessageScanComplete: false, lastMessageRole: null,
  composerPromptState: null, composerAttachmentCount: null,
  composerPastedTextAttachmentPresent: false, composerSendButtonEnabled: null,
  responseFailure: null,
};

test('omitted and explicit null/false defaults hash identically, individually and together', () => {
  const expected = hash(required);
  for (const [field, value] of Object.entries(defaults)) {
    assert.equal(hash({ ...required, [field]: value }), expected, field);
  }
  assert.equal(hash({ ...required, ...defaults }), expected);
});

const changes = {
  conversationUrl: 'https://chatgpt.com/c/other', selectedModelLabel: 'Pro Extended',
  hydrated: false, baselineUserMessageCount: 4,
  observationBaselineUserMessageCount: 2, observedUserMessageCount: 4,
  assistantMessageCount: 1, countRegressionDetected: true,
  requestMessageFound: false, requestMessageFoundBy: 'request_id_scan',
  requestMessageScanComplete: true, isAnswering: true,
  lastMessageRole: 'assistant', composerPromptState: 'empty',
  composerAttachmentCount: 1, composerPastedTextAttachmentPresent: true,
  composerSendButtonEnabled: false,
  responseFailure: { code: 'CHATGPT_THINKING_FAILED', message: 'Thinking failed',
    assistantTextHash: 'fixture-hash', retryActionAvailable: false },
};
for (const [field, value] of Object.entries(changes)) {
  test(`hash includes ${field}`, () => {
    assert.notEqual(hash({ ...required, ...defaults, [field]: value }),
      hash({ ...required, ...defaults }), field);
  });
}

test('nested failure content contributes to the hash', () => {
  const evidence = { ...required, responseFailure: changes.responseFailure };
  assert.notEqual(hash({ ...evidence, responseFailure: {
    ...evidence.responseFailure, assistantTextHash: 'another-fixture-hash',
  } }), hash(evidence));
});

test('unknown top-level fields are ignored and input is unchanged', () => {
  const evidence = { ...required, ...defaults, responseFailure: { ...changes.responseFailure },
    unknownDiagnostic: { text: 'not hash evidence' } };
  const before = structuredClone(evidence);
  Object.freeze(evidence.responseFailure);
  Object.freeze(evidence.unknownDiagnostic);
  Object.freeze(evidence);
  const expected = hash({ ...required, ...defaults, responseFailure: changes.responseFailure });
  assert.equal(hash(evidence), expected);
  assert.equal(hash({ ...evidence, unknownDiagnostic: { text: 'changed' } }), expected);
  assert.deepEqual(evidence, before);
});
