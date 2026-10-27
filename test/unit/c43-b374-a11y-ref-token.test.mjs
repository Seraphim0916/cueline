import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAccessibilityTree } from '../../dist/src/browser/claude-desktop/a11y-tree.js';

const attributes = [
  'href="/docs/[ref_fake]"',
  "href='/docs/[ref_fake]'",
  'title="before [ref_fake] after"',
  "title='before [ref_fake] after'",
  String.raw`title="say \" [ref_fake] \" now"`,
  String.raw`title='say \' [ref_fake] \' now'`,
  String.raw`title="path \\ [ref_fake] end"`,
  String.raw`title='path \\ [ref_fake] end'`,
];

test('quoted attribute references never become operation targets', () => {
  for (const attribute of attributes) {
    const [node] = parseAccessibilityTree(`link "Docs" ${attribute}`);
    assert.equal(Object.hasOwn(node, 'ref'), false, attribute);
  }
});

test('quoted fake references cannot mask a real standalone reference', () => {
  for (const attribute of attributes) {
    for (const rest of [`${attribute} [ref_real]`, `[ref_real] ${attribute}`]) {
      assert.equal(parseAccessibilityTree(`link "Docs" ${rest}`)[0].ref, 'ref_real', rest);
    }
  }
});

test('only whole reference tokens qualify, with whitespace boundaries', () => {
  for (const text of ['href=[ref_fake]', 'prefix[ref_fake]', '[ref_fake]suffix', '[[ref_fake]]']) {
    assert.equal(parseAccessibilityTree(`link "Docs" ${text}`)[0].ref, undefined, text);
    assert.equal(parseAccessibilityTree(`link "Docs" ${text}\t[ref_real_2]`)[0].ref, 'ref_real_2', text);
  }
  assert.equal(parseAccessibilityTree('button\t[ref_1] type="button"')[0].ref, 'ref_1');
  assert.equal(parseAccessibilityTree('link "[ref_name]" [ref_real]')[0].ref, 'ref_real');
});
