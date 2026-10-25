import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const dataUrl = source => `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`;
let source = await readFile(new URL('../../src/browser/codex-iab/tab-discovery.ts', import.meta.url), 'utf8');
for (const name of ['errors', 'conversation-url']) {
  source = source.replace(`"../../core/${name}.js"`, JSON.stringify(dataUrl(await readFile(new URL(`../../src/core/${name}.ts`, import.meta.url), 'utf8'))));
}
source = source.replace('"./selectors.js"', JSON.stringify(dataUrl(await readFile(new URL('../../src/browser/codex-iab/selectors.ts', import.meta.url), 'utf8'))));
const { acquireChatGptTab } = await import(dataUrl(source));
const expected = 'https://chatgpt.com/c/expected';

function fixture(route, actual, afterLoad) {
  let current = actual;
  let loaded = false;
  const tab = { url: async () => current, playwright: { waitForLoadState: async () => {
    loaded = true;
    if (afterLoad !== undefined) current = afterLoad;
  } } };
  const listing = [{ id: 'fake-tab', url: expected }];
  const browser = { tabs: { new: async () => { throw new Error('must not create a tab'); } } };
  if (route === 'session') Object.assign(browser.tabs, { list: async () => listing, get: async () => tab });
  else browser.user = { openTabs: async () => listing, claimTab: async () => tab };
  return { browser, tab, loaded: () => loaded };
}

for (const route of ['session', 'user']) {
  for (const [name, actual, afterLoad] of [
    ['stale listing', 'https://chatgpt.com/c/other'],
    ['navigation during loading', expected, 'https://chatgpt.com/c/other'],
    ['missing URL', undefined],
    ['invalid origin', 'https://example.test/c/expected'],
  ]) {
    test(`${route}: rejects ${name}`, async () => {
      const { browser } = fixture(route, actual, afterLoad);
      await assert.rejects(acquireChatGptTab(browser, expected), { code: 'IAB_CHATGPT_TAB_URL_MISMATCH' });
    });
  }
  test(`${route}: accepts matching normalized URL after loading`, async () => {
    const { browser, tab, loaded } = fixture(route, `${expected}/?view=1`);
    assert.equal(await acquireChatGptTab(browser, expected), tab);
    assert.equal(loaded(), true);
  });
  test(`${route}: no conversation requested still accepts ChatGPT`, async () => {
    const { browser, tab } = fixture(route, 'https://chatgpt.com/');
    assert.equal(await acquireChatGptTab(browser), tab);
  });
}
