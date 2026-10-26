import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const dataUrl = source => `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`;
const selectors = dataUrl(await readFile(new URL('../../src/browser/codex-iab/selectors.ts', import.meta.url), 'utf8'));
const source = await readFile(new URL('../../src/browser/codex-iab/send-button.ts', import.meta.url), 'utf8');
const { inspectVisibleSendButton } = await import(dataUrl(source.replace('"./selectors.js"', JSON.stringify(selectors))));

test('only a unique qualified button reaches the real callback hit test', async () => {
  const saved = Object.fromEntries(['document', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let hitTests = 0;
  let evaluations = 0;
  let buttons = [];
  const rect = { x: 10, y: 20, width: 40, height: 40, top: 20, right: 50, bottom: 60, left: 10 };
  const makeButton = () => ({
    tagName: 'BUTTON', className: '', disabled: false, hidden: false,
    getAttribute: name => name === 'aria-label' ? 'Send message' : null,
    closest(selector) { return selector === 'button' ? this : null; },
    contains(element) { return element === this; },
    getBoundingClientRect: () => rect,
    getClientRects: () => [rect],
    checkVisibility: () => true,
  });
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      innerWidth: 800, innerHeight: 600, devicePixelRatio: 2,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', pointerEvents: 'auto', opacity: '1' }),
    } });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
      querySelectorAll(selector) { assert.equal(selector, 'button'); return buttons; },
      elementFromPoint(x, y) {
        hitTests += 1;
        assert.deepEqual({ x, y }, { x: 30, y: 40 });
        return buttons[0];
      },
      hasFocus: () => true,
      visibilityState: 'visible',
    } });
    const tab = { id: 'ambiguity', playwright: { evaluate: async (callback, args) => {
      evaluations += 1;
      return callback(args);
    } } };
    for (const count of [0, 2]) {
      buttons = Array.from({ length: count }, makeButton);
      const result = await inspectVisibleSendButton(tab);
      assert.equal(result, undefined);
      assert.equal(hitTests, 0, `${count} candidates must skip hit testing`);
      console.log(`candidates ${count} result ${result}`);
    }
    console.log(`hitTests ${hitTests}`);
    // Test both members independently so two invalid fixtures cannot mask ambiguity.
    const pair = buttons;
    for (const button of pair) {
      buttons = [button];
      const result = await inspectVisibleSendButton(tab);
      assert.deepEqual(result.coordinate, { x: 30, y: 40 });
      assert.equal(result.elementFromPointMatchesButton, true);
    }
    assert.equal(hitTests, 2);
    assert.equal(evaluations, 4);
  } finally {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
  for (const [key, descriptor] of Object.entries(saved)) {
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, key), descriptor);
  }
});
