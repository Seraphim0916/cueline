import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAccessibilityTree, findNodesByRole } from '../../src/browser/claude-desktop/a11y-tree.ts';

test('names decode whitespace escapes and remain locatable by normalized name', () => {
  const nodes = parseAccessibilityTree(String.raw`button "Line\nBreak\tNext\rEnd" [ref_1]`);
  assert.equal(nodes[0].name, 'Line\nBreak\tNext\rEnd');
  assert.equal(findNodesByRole(nodes, 'BUTTON', ' line break next end ')[0]?.ref, 'ref_1');
});

test('quotes and backslashes decode once while unknown escapes remain literal', () => {
  const nodes = parseAccessibilityTree(String.raw`button "Say \"hello\" at C:\\new\q" [ref_2]`);
  assert.equal(nodes[0].name, String.raw`Say "hello" at C:\new\q`);
  assert.equal(findNodesByRole(nodes, 'button', String.raw`Say "hello" at C:\new\q`).length, 1);
  assert.equal(parseAccessibilityTree(String.raw`button "literal \\n"`)[0].name, String.raw`literal \n`);
});
