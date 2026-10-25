import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const dataUrl = (source) => `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`;
let source = await readFile(new URL('../../src/core/controller-conversation-archive.ts', import.meta.url), 'utf8');
for (const name of ['conversation-url', 'errors']) {
  source = source.replace(`"./${name}.js"`, JSON.stringify(dataUrl(
    await readFile(new URL(`../../src/core/${name}.ts`, import.meta.url), 'utf8'),
  )));
}
const { controllerConversationArchiveNeedsRecovery, settleControllerConversationArchive } = await import(dataUrl(source));

test('70 archive combinations: only complete enabled pending/started need recovery', async () => {
  const runStatuses = ['running', 'complete', 'blocked', 'cancelled', 'failed'];
  const archiveStatuses = ['disabled', 'waiting_for_completion', 'pending', 'started', 'archived', 'ambiguous', 'failed'];
  const recoveryCases = new Set(['complete/true/pending', 'complete/true/started']);
  let combinations = 0;
  let noops = 0;
  const effects = { append: 0, snapshot: 0, browser: 0 };
  const unexpected = (kind) => () => {
    effects[kind] += 1;
    throw new Error(`unexpected ${kind} side effect`);
  };
  for (const status of runStatuses) {
    for (const enabled of [false, true]) {
      for (const archiveStatus of archiveStatuses) {
        const label = `${status}/${enabled}/${archiveStatus}`;
        const state = {
          status,
          conversationUrl: 'https://chatgpt.com/c/archive-fixture',
          controllerConversationArchive: { enabled, status: archiveStatus },
        };
        const expected = recoveryCases.has(label);
        assert.equal(controllerConversationArchiveNeedsRecovery(state), expected, label);
        combinations += 1;
        if (expected) continue;
        const before = structuredClone(state);
        const store = { state, append: unexpected('append'), snapshot: unexpected('snapshot') };
        const browser = new Proxy({}, { get: unexpected('browser') });
        assert.equal(await settleControllerConversationArchive(store, { browser }), undefined, label);
        assert.deepEqual(effects, { append: 0, snapshot: 0, browser: 0 }, label);
        assert.deepEqual(state, before, `${label}: state must remain unchanged`);
        noops += 1;
      }
    }
  }
  assert.equal(combinations, 70);
  assert.equal(noops, 68);
  console.log('70 combinations; 68 no-op cases; archive no-op side effects 0');
});
