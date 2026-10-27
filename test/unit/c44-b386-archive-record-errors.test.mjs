import assert from 'node:assert/strict';
import test from 'node:test';
import { settleControllerConversationArchive } from '../../dist/src/core/controller-conversation-archive.js';

for (const failingOperation of ['append', 'snapshot']) {
  test(`interrupted archive propagates original ${failingOperation} error without browser access`, async () => {
    const failure = new Error(`${failingOperation} recovery record failed`);
    const events = [];
    let snapshots = 0;
    let browserAccesses = 0;
    let browserCalls = 0;
    const store = {
      state: { status: 'complete', conversationUrl: 'https://chatgpt.com/c/record-errors',
        controllerConversationArchive: { enabled: true, status: 'started' } },
      async append(type, payload) {
        events.push({ type, payload });
        if (failingOperation === 'append') throw failure;
        this.state.controllerConversationArchive.status = 'ambiguous';
      },
      async snapshot() { snapshots++; throw failure; },
    };
    const browser = {
      get archiveConversation() {
        browserAccesses++;
        return async () => { browserCalls++; throw new Error('browser must not be called'); };
      },
    };
    await assert.rejects(settleControllerConversationArchive(store, { browser }), error => {
      assert.strictEqual(error, failure);
      console.log(`${failingOperation} sameError ${error === failure}`);
      return true;
    });
    assert.equal(browserAccesses, 0);
    assert.equal(browserCalls, 0);
    assert.deepEqual(events.map(event => event.type), ['controller_conversation_archive_ambiguous']);
    assert.equal(events[0].payload.code, 'CONTROLLER_CONVERSATION_ARCHIVE_INTERRUPTED');
    assert.equal(snapshots, failingOperation === 'append' ? 0 : 1);
    assert.equal(store.state.controllerConversationArchive.status, failingOperation === 'append' ? 'started' : 'ambiguous');
  });
}
