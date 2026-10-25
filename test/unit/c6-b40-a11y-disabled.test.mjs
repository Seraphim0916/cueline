import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAccessibilityTree } from '../../src/browser/claude-desktop/a11y-tree.ts';

test('only complete enabled disabled-state attributes disable a node', () => {
  for (const suffix of ['disabled', '[disabled]', 'disabled=true', '[disabled=true]']) {
    assert.equal(parseAccessibilityTree(`button "Send" [ref_1] ${suffix}`)[0].disabled,
      true, suffix);
  }
});

test('attribute values, names and explicit false are not disabled markers', () => {
  for (const suffix of ['', 'href="/disabled"', 'title="is disabled now"',
    'title="[disabled]"', 'data-disabled=true', 'disabled=false', '[disabled=false]',
    'href=/disabled', 'title="say \\"disabled\\" now"']) {
    assert.equal(parseAccessibilityTree(`link "disabled" [ref_1] ${suffix}`)[0].disabled,
      false, suffix);
  }
});
