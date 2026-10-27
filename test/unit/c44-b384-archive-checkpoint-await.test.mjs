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
  console.log(`waiting ${trace.join(',')}`);
  snapshotGate.resolve();
  await new Promise(setImmediate);
  assert.deepEqual(trace, ['started', 'snapshot', 'click']);
  browserReturned.resolve();
  await settling;
  assert.deepEqual(trace, ['started', 'snapshot', 'click', 'archived', 'snapshot']);
  assert.equal(store.state.controllerConversationArchive.status, 'archived');
  console.log(`released ${trace.join(',')}`);
});
