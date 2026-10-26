import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const asModule = source => `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`;
const urls = asModule(await readFile(new URL('../../src/core/conversation-url.ts', import.meta.url), 'utf8'));
const source = await readFile(new URL('../../src/core/submitted-turn-recovery.ts', import.meta.url), 'utf8');
const { isDefinitelyNotSentObservation } = await import(asModule(source.replace('./conversation-url.js', urls)));
const conversationUrl = 'https://chatgpt.com/c/staged-attachment';
const turn = {
  round: 5, requestId: 'msg_attachment', manualSendConfirmed: false,
  retryOfRequestId: null, submissionCheckpointContract: 'write_ahead_v1',
  baselineUserMessageCount: 4, promptHash: 'a'.repeat(64), selectedModelLabel: 'Pro',
  submissionState: 'submitting', composerPromptState: 'attachment_ready',
};
const evidence = {
  conversationUrl, selectedModelLabel: 'Pro', hydrated: true,
  baselineUserMessageCount: 4, observedUserMessageCount: 4,
  requestMessageFound: false, isAnswering: false,
  composerPromptState: 'attachment_ready', composerAttachmentCount: 1,
  composerSendButtonEnabled: true,
};

test('submitting attachment with count 1 and enabled send button is definitely not sent', () => {
  assert.equal(isDefinitelyNotSentObservation(turn, conversationUrl, evidence), true);
});

for (const count of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test(`rejects staged attachment count ${String(count)}`, () => {
    assert.equal(isDefinitelyNotSentObservation(turn, conversationUrl, { ...evidence, composerAttachmentCount: count }), false);
  });
}

test('positive attachment count cannot compensate for a disabled send button', () => {
  assert.equal(isDefinitelyNotSentObservation(turn, conversationUrl, { ...evidence, composerSendButtonEnabled: false }), false);
});
