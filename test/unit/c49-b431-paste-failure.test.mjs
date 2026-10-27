import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const dataUrl = (s) => `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(s))}`;
const errors = dataUrl(await readFile(new URL('../../src/core/errors.ts', import.meta.url), 'utf8'));
const tree = dataUrl(await readFile(new URL('../../src/browser/claude-desktop/a11y-tree.ts', import.meta.url), 'utf8'));
const source = await readFile(new URL('../../src/browser/claude-desktop/iab-shim.ts', import.meta.url), 'utf8');
const { createClaudeDesktopIabBrowser } = await import(dataUrl(source
  .replace('"../../core/errors.js"', JSON.stringify(errors))
  .replace('"./a11y-tree.js"', JSON.stringify(tree))));

for (const wrapped of [false, true]) {
  for (const [name, result, fails] of [
    ['explicit failure', { ok: false, reason: 'editable_target_not_unique' }, true],
    ['success', { ok: true }, false],
    ['consumed paste', { ok: true, defaultPrevented: true }, false],
    ['null legacy result', null, false],
  ]) {
    test(`${wrapped ? 'envelope' : 'raw'} ${name}`, async () => {
      const calls = [];
      const browser = createClaudeDesktopIabBrowser({ tools: {
        async listTabs() { return [{ tabId: 'tab', url: 'https://chatgpt.com/' }]; },
        async readPage() { return 'textbox "Message" [ref_6]'; },
        async clickRef(...args) { calls.push(['click', ...args]); },
        async evaluate(tab, source) {
          calls.push(['evaluate', tab]);
          assert.match(source, /ClipboardEvent/);
          return wrapped ? { protocol: 'cueline.evaluate-result/1', encoding: 'json', value: JSON.stringify(result) } : result;
        },
      } });
      const tab = await browser.tabs.get('tab');
      const fill = () => tab.playwright.getByRole('textbox', { name: 'Message' }).fill('hello');
      if (fails) await assert.rejects(fill, { code: 'IAB_PASTE_FAILED' });
      else await assert.doesNotReject(fill);
      assert.deepEqual(calls, [['click', 'tab', 'ref_6'], ['evaluate', 'tab']]);
    });
  }
}

test('undefined legacy result remains successful', async () => {
  const browser = createClaudeDesktopIabBrowser({ tools: {
    async listTabs() { return [{ tabId: 'tab', url: 'https://chatgpt.com/' }]; },
    async readPage() { return 'textbox "Message" [ref_6]'; },
    async clickRef() {}, async evaluate() {},
  } });
  const tab = await browser.tabs.get('tab');
  await assert.doesNotReject(() => tab.playwright.getByRole('textbox', { name: 'Message' }).fill('hello'));
});
