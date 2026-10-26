import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const asModule = source => `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`;
const urls = asModule(await readFile(new URL('../../src/core/conversation-url.ts', import.meta.url), 'utf8'));
const source = await readFile(new URL('../../src/core/submitted-turn-recovery.ts', import.meta.url), 'utf8');
const { isDefinitelyNotSentObservation } = await import(asModule(source.replace('./conversation-url.js', urls)));
const conversationUrl = 'https://chatgpt.com/c/branch-identity';
const turn = {
  round: 5, requestId: 'msg_current', manualSendConfirmed: false,
  retryOfRequestId: null, submissionCheckpointContract: 'write_ahead_v1',
  baselineUserMessageCount: 448, promptHash: 'a'.repeat(64), selectedModelLabel: 'Pro',
  submissionState: 'submitted', composerPromptState: 'attachment_ready',
};
const branch = {
  code: 'CONTROLLER_OBSERVATION_BRANCH_LEAF_MISMATCH',
  expectedRound: turn.round, expectedRequestId: turn.requestId,
  branchSearchPerformed: true, branchSearchFoundExactEnvelope: false,
  branchLocalUserMessageCount: turn.baselineUserMessageCount,
};
const evidence = {
  conversationUrl, selectedModelLabel: 'Pro', hydrated: true,
  baselineUserMessageCount: 448, observedUserMessageCount: 452,
  requestMessageFound: false, requestMessageScanComplete: true,
  accessibilityRequestIdFound: false, isAnswering: false,
  composerPromptState: 'empty', composerAttachmentCount: 0,
  composerPastedTextAttachmentPresent: false, composerSendButtonEnabled: false,
};

test('aggregate count above baseline accepts matching current-turn branch evidence', () => {
  assert.ok(evidence.observedUserMessageCount > turn.baselineUserMessageCount);
  assert.equal(isDefinitelyNotSentObservation(turn, conversationUrl, { ...evidence, branchLeafMismatch: branch }), true);
});

for (const [field, value] of [
  ['expectedRound', 4], ['expectedRequestId', 'msg_other'],
  ['branchSearchPerformed', false], ['branchSearchPerformed', undefined],
  ['branchSearchFoundExactEnvelope', true], ['branchSearchFoundExactEnvelope', undefined],
]) {
  test(`rejects branch evidence with ${field}=${String(value)}`, () => {
    const mismatch = { ...branch, [field]: value };
    if (value === undefined) delete mismatch[field];
    assert.equal(isDefinitelyNotSentObservation(turn, conversationUrl, { ...evidence, branchLeafMismatch: mismatch }), false);
  });
}
