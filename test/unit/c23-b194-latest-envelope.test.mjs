import assert from 'node:assert/strict';
import test from 'node:test';
import {
  exactControllerEnvelopeText,
  hasExactControllerEnvelopeIdentity,
  latestControllerEnvelopeIdentity,
} from '../../dist/src/browser/codex-iab/recovery-evidence.js';

const oldIdentity = { runId: 'run', round: 1, requestId: 'old' };
const newIdentity = { runId: 'run', round: 2, requestId: 'new' };
const envelope = identity => `<CueLineControl>${JSON.stringify({
  protocol: 'cueline/0.1', run_id: identity.runId,
  round: identity.round, request_id: identity.requestId,
})}</CueLineControl>`;

test('only the newest complete envelope is eligible, across repeated queries', () => {
  const text = `${envelope(oldIdentity)}\n${envelope(newIdentity)}`;
  for (let repeat = 0; repeat < 3; repeat += 1) {
    assert.equal(exactControllerEnvelopeText(text, oldIdentity), null);
    assert.equal(hasExactControllerEnvelopeIdentity(text, oldIdentity), false);
    assert.deepEqual(latestControllerEnvelopeIdentity(text), newIdentity);
    assert.equal(exactControllerEnvelopeText(text, newIdentity), envelope(newIdentity));
    assert.equal(hasExactControllerEnvelopeIdentity(text, newIdentity), true);
    // Interleave another input to expose accidental shared regex cursor state.
    assert.deepEqual(latestControllerEnvelopeIdentity(envelope(oldIdentity)), oldIdentity);
  }
  console.log('old_then_new', hasExactControllerEnvelopeIdentity(text, oldIdentity));
  console.log('latest_request_id', latestControllerEnvelopeIdentity(text).requestId);
});

test('a malformed last complete envelope cannot fall back to an older match', () => {
  const text = `${envelope(oldIdentity)}\n${envelope(newIdentity)}\n<CueLineControl>{broken}</CueLineControl>`;
  for (let repeat = 0; repeat < 3; repeat += 1) {
    for (const identity of [oldIdentity, newIdentity]) {
      assert.equal(exactControllerEnvelopeText(text, identity), null);
      assert.equal(hasExactControllerEnvelopeIdentity(text, identity), false);
    }
    assert.equal(latestControllerEnvelopeIdentity(text), null);
    assert.deepEqual(latestControllerEnvelopeIdentity(envelope(newIdentity)), newIdentity);
  }
  console.log('malformed_last', latestControllerEnvelopeIdentity(text));
});
