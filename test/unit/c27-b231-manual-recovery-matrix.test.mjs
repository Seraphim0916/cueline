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
let isSubmittedTurnRecoveryCandidate;
try {
  ({ isSubmittedTurnRecoveryCandidate } = await import('../../src/core/submitted-turn-recovery.ts'));
} finally {
  hooks.deregister();
}

const conversationUrl = 'https://chatgpt.com/c/c27-manual-recovery';
const turn = overrides => ({
  round: 5,
  requestId: 'msg_c27b231',
  manualSendConfirmed: false,
  retryOfRequestId: null,
  submissionCheckpointContract: 'write_ahead_v1',
  baselineUserMessageCount: 12,
  promptHash: 'a'.repeat(64),
  selectedModelLabel: 'Pro',
  submissionState: 'submitted',
  ...overrides,
});
const candidate = overrides => isSubmittedTurnRecoveryCandidate(turn(overrides), conversationUrl);

// 鎖住現況：人工確認只認 true／false 兩個布林值；possibly_sent 必須人工確認為 true 才可回收，
// submitted 確認為 true 或 false 都可回收，requested、submitting 一律不可。非布林值一律拒絕。
const CONFIRMATIONS = [false, true, 1];
const EXPECTED = {
  requested: [false, false, false],
  submitting: [false, false, false],
  possibly_sent: [false, true, false],
  submitted: [true, true, false],
};

for (const [submissionState, expected] of Object.entries(EXPECTED)) {
  test(`${submissionState}: manualSendConfirmed false/true/1 -> ${expected.join('/')}`, () => {
    assert.deepEqual(
      CONFIRMATIONS.map(manualSendConfirmed => candidate({ submissionState, manualSendConfirmed })), expected);
  });

  test(`${submissionState}: other non-boolean confirmations are rejected`, () => {
    for (const manualSendConfirmed of [0, 'true', 'false', null, undefined, {}, []]) {
      assert.equal(candidate({ submissionState, manualSendConfirmed }), false, String(manualSendConfirmed));
    }
  });
}

for (const [label, retryOfRequestId, accepted] of [
  ['missing', undefined, true],
  ['null', null, true],
  ['empty string', '', false],
  ['non-empty string', 'msg_previous', false],
]) {
  test(`retryOfRequestId ${label} -> ${accepted ? 'follows the matrix' : 'always rejected'}`, () => {
    for (const [submissionState, expected] of Object.entries(EXPECTED)) {
      const overrides = { submissionState, retryOfRequestId };
      if (retryOfRequestId === undefined) delete overrides.retryOfRequestId;
      const actual = CONFIRMATIONS.map(manualSendConfirmed => {
        const t = turn({ ...overrides, manualSendConfirmed });
        if (retryOfRequestId === undefined) delete t.retryOfRequestId;
        return isSubmittedTurnRecoveryCandidate(t, conversationUrl);
      });
      assert.deepEqual(actual, accepted ? expected : [false, false, false], submissionState);
    }
  });
}
