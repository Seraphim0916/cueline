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
  test(`${failingOperation} checkpoint failure prevents click and preserves recovery branch`, async () => {
    const failure = new Error(`${failingOperation} checkpoint failed`);
    const events = [];
    const attempts = [];
    let snapshots = 0;
    let browserCalls = 0;
    let clicks = 0;
    const store = {
      state: { status: 'complete', conversationUrl: 'https://chatgpt.com/c/checkpoint-errors',
        controllerConversationArchive: { enabled: true, status: 'pending' } },
      async append(type, payload) {
        attempts.push(type);
        if (type === 'controller_conversation_archive_started' && failingOperation === 'append') throw failure;
        events.push({ type, payload });
        if (type === 'controller_conversation_archive_started') this.state.controllerConversationArchive.status = 'started';
        if (type === 'controller_conversation_archive_ambiguous') this.state.controllerConversationArchive.status = 'ambiguous';
      },
      async snapshot() {
        if (++snapshots === 1 && failingOperation === 'snapshot') throw failure;
      },
    };
    await settleControllerConversationArchive(store, { browser: {
      async archiveConversation(_request, hooks) {
        browserCalls++;
        await hooks.onBeforeArchiveClick();
        clicks++;
        throw new Error('unexpected click');
      },
    } });
    const started = 'controller_conversation_archive_started';
    const failureType = failingOperation === 'append'
      ? 'controller_conversation_archive_preflight_failed' : 'controller_conversation_archive_ambiguous';
    assert.equal(browserCalls, 1);
    assert.equal(clicks, 0);
    assert.deepEqual(attempts, [started, failureType]);
    assert.deepEqual(events.map(event => event.type), failingOperation === 'append' ? [failureType] : [started, failureType]);
    assert.equal(events.at(-1).payload.message, failure.message);
    assert.equal(events.at(-1).payload.code, failingOperation === 'append'
      ? 'CONTROLLER_CONVERSATION_ARCHIVE_PREFLIGHT_FAILED' : 'CONTROLLER_CONVERSATION_ARCHIVE_AMBIGUOUS');
    assert.equal(snapshots, failingOperation === 'append' ? 1 : 2);
    assert.equal(store.state.controllerConversationArchive.status, failingOperation === 'append' ? 'pending' : 'ambiguous');
    console.log(`${failingOperation} clicks ${clicks} status ${store.state.controllerConversationArchive.status}`);
  });
}
