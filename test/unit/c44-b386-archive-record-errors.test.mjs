import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const asModule = source => `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`;
let source = await readFile(new URL('../../src/core/controller-conversation-archive.ts', import.meta.url), 'utf8');
for (const dependency of ['errors', 'conversation-url']) {
  source = source.replace(`./${dependency}.js`, asModule(await readFile(
    new URL(`../../src/core/${dependency}.ts`, import.meta.url), 'utf8')));
}
const { settleControllerConversationArchive } = await import(process.env.CUELINE_ARCHIVE_COMPILED === '1'
  ? new URL('../../dist/src/core/controller-conversation-archive.js', import.meta.url).href
  : asModule(source));

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
