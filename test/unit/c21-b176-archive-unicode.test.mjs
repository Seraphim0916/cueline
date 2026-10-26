import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const asModule = source => `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`;
let source = await readFile(new URL('../../src/core/controller-conversation-archive.ts', import.meta.url), 'utf8');
for (const dependency of ['errors', 'conversation-url']) {
  const url = new URL(`../../src/core/${dependency}.ts`, import.meta.url);
  source = source.replace(`./${dependency}.js`, asModule(await readFile(url, 'utf8')));
}
const { settleControllerConversationArchive } = await import(asModule(source));

for (const started of [false, true]) {
  for (const [label, message, expected] of [
    ['split pair', 'a'.repeat(1999) + '😀tail', 'a'.repeat(1999) + '…'],
    ['complete pair', 'a'.repeat(1998) + '😀tail', 'a'.repeat(1998) + '😀…'],
    ['exact limit', 'a'.repeat(1998) + '😀', 'a'.repeat(1998) + '😀'],
    ['ASCII truncation', 'a'.repeat(2001), 'a'.repeat(2000) + '…'],
    ['short Unicode', '封存😀失敗', '封存😀失敗'],
  ]) {
    test(`${started ? 'after start' : 'preflight'}: ${label}`, async () => {
      const events = [];
      let snapshots = 0;
      const store = {
        state: {
          status: 'complete', conversationUrl: 'https://chatgpt.com/c/archive-test',
          controllerConversationArchive: { enabled: true, status: 'pending' },
        },
        async append(type, payload) {
          events.push({ type, payload });
          if (type === 'controller_conversation_archive_started') {
            this.state.controllerConversationArchive.status = 'started';
          }
        },
        async snapshot() { snapshots += 1; },
      };
      await settleControllerConversationArchive(store, {
        browser: {
          async archiveConversation(_request, hooks) {
            if (started) await hooks.onBeforeArchiveClick();
            throw new Error(message);
          },
        },
      });
      const failureType = started ? 'controller_conversation_archive_ambiguous' : 'controller_conversation_archive_preflight_failed';
      assert.deepEqual(events.map(event => event.type), started
        ? ['controller_conversation_archive_started', failureType] : [failureType]);
      const failure = events.at(-1).payload;
      assert.equal(failure.code, started ? 'CONTROLLER_CONVERSATION_ARCHIVE_AMBIGUOUS' : 'CONTROLLER_CONVERSATION_ARCHIVE_PREFLIGHT_FAILED');
      assert.equal(failure.message, expected);
      assert.equal(failure.message.isWellFormed(), true);
      assert.ok(failure.message.length <= 2001);
      assert.equal(snapshots, events.length);
    });
  }
}
