import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const asModule = source => `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`;
const urls = asModule(await readFile(new URL('../../src/core/conversation-url.ts', import.meta.url), 'utf8'));
const source = await readFile(new URL('../../src/core/submitted-turn-recovery.ts', import.meta.url), 'utf8');
const { isSubmittedTurnRecoveryCandidate } = await import(asModule(source.replace('./conversation-url.js', urls)));
const conversationUrl = 'https://chatgpt.com/c/recovery-hash';
const validHash = '0123456789abcdef'.repeat(4);

for (const [manualSendConfirmed, submissionState] of [
  [false, 'submitted'], [true, 'submitted'], [true, 'possibly_sent'],
]) {
  const turn = {
    round: 5, requestId: 'msg_hash', manualSendConfirmed, submissionState,
    retryOfRequestId: null, submissionCheckpointContract: 'write_ahead_v1',
    baselineUserMessageCount: 4, promptHash: validHash, selectedModelLabel: 'Pro',
  };
  for (const [label, promptHash, expected] of [
    ['64 lowercase hexadecimal characters', validHash, true],
    ['63 characters', validHash.slice(1), false],
    ['65 characters', validHash + 'a', false],
    ['non-hexadecimal character', validHash.slice(1) + 'g', false],
    ['uppercase hexadecimal characters', validHash.toUpperCase(), false],
    ['trailing LF', validHash + '\n', false],
    ['trailing CR', validHash + '\r', false],
    ['trailing U+2028', validHash + '\u2028', false],
  ]) {
    test(`manual=${manualSendConfirmed} ${submissionState}: ${label} => ${expected}`, () => {
      assert.equal(isSubmittedTurnRecoveryCandidate({ ...turn, promptHash }, conversationUrl), expected);
    });
  }
}
