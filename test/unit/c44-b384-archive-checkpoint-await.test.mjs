import assert from 'node:assert/strict';
import test from 'node:test';
import { settleControllerConversationArchive } from '../../dist/src/core/controller-conversation-archive.js';

test('archive click awaits both append and snapshot checkpoints', async () => {
  const appendGate = Promise.withResolvers();
  const snapshotGate = Promise.withResolvers();
  const snapshotEntered = Promise.withResolvers();
  const browserReturned = Promise.withResolvers();
  const trace = [];
  const conversationUrl = 'https://chatgpt.com/c/checkpoint-await';
  let snapshots = 0;
  const store = {
    state: { status: 'complete', conversationUrl,
      controllerConversationArchive: { enabled: true, status: 'pending' } },
    async append(type) {
      if (type === 'controller_conversation_archive_started') {
        trace.push('started');
        await appendGate.promise;
        this.state.controllerConversationArchive.status = 'started';
      } else {
        assert.equal(type, 'controller_conversation_archived');
        trace.push('archived');
        this.state.controllerConversationArchive.status = 'archived';
      }
    },
    async snapshot() {
      trace.push('snapshot');
      if (++snapshots === 1) {
        snapshotEntered.resolve();
        await snapshotGate.promise;
      }
    },
  };
  const settling = settleControllerConversationArchive(store, { browser: {
    async archiveConversation(_request, hooks) {
      await hooks.onBeforeArchiveClick();
      trace.push('click');
      await browserReturned.promise;
      return { conversationUrl, proof: 'conversation_url_changed', postActionUrl: 'https://chatgpt.com/' };
    },
  } });
  // Yield an event-loop turn, without a timer, so an omitted await can advance.
  await new Promise(setImmediate);
  assert.deepEqual(trace, ['started']);
  assert.equal(store.state.controllerConversationArchive.status, 'pending');
  appendGate.resolve();
  await snapshotEntered.promise;
  await new Promise(setImmediate);
  assert.deepEqual(trace, ['started', 'snapshot']);
  assert.equal(store.state.controllerConversationArchive.status, 'started');
  snapshotGate.resolve();
  await new Promise(setImmediate);
  assert.deepEqual(trace, ['started', 'snapshot', 'click']);
  browserReturned.resolve();
  await settling;
  assert.deepEqual(trace, ['started', 'snapshot', 'click', 'archived', 'snapshot']);
  assert.equal(store.state.controllerConversationArchive.status, 'archived');
});
