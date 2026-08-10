import assert from "node:assert/strict";
import test from "node:test";

import {
  findNodesByRole,
  parseAccessibilityTree,
} from "../../src/browser/claude-desktop/a11y-tree.js";
import { COMPOSER_TEXTBOX_NAMES } from "../../src/browser/codex-iab/selectors.js";

/** Captured verbatim from a Claude Code host reading a live ChatGPT conversation. */
const CAPTURED_TREE = `link "Skip content" [ref_1] href="#main"
button [ref_2] type="button"
link "New chat" [ref_3] href="/"
button "More" [ref_4]
button "Add files more" [ref_5] type="button"
textbox "Chat with ChatGPT" [ref_6]
button [ref_7] type="button"
button "Start dictation" [ref_8] type="button"
button "Start Voice" [ref_9] type="button"
Viewport: 574x1243`;

test("every node line of a captured tree is parsed", () => {
  const nodes = parseAccessibilityTree(CAPTURED_TREE);
  assert.equal(nodes.length, 9, "the Viewport footer must not become a node");
  assert.deepEqual(nodes[0], {
    role: "link",
    name: "Skip content",
    ref: "ref_1",
    depth: 0,
    disabled: false,
  });
});

test("an unnamed node keeps its handle and omits the name", () => {
  const node = parseAccessibilityTree(CAPTURED_TREE)[1]!;
  assert.equal(node.role, "button");
  assert.equal(node.ref, "ref_2");
  assert.equal(node.name, undefined);
});

test("the composer resolves through the shared selector constants", () => {
  const nodes = parseAccessibilityTree(CAPTURED_TREE);
  const matched = COMPOSER_TEXTBOX_NAMES.flatMap((name) =>
    findNodesByRole(nodes, "textbox", name),
  );
  assert.equal(matched.length, 1);
  assert.equal(matched[0]!.ref, "ref_6");
});

test("name matching collapses whitespace and ignores case", () => {
  const nodes = parseAccessibilityTree(CAPTURED_TREE);
  assert.equal(findNodesByRole(nodes, "BUTTON", "  start   dictation ")[0]?.ref, "ref_8");
});

test("a name that only partly matches is not accepted", () => {
  const nodes = parseAccessibilityTree(CAPTURED_TREE);
  assert.deepEqual(findNodesByRole(nodes, "button", "Start"), []);
});

test("disabled state is read from the trailing attributes", () => {
  const nodes = parseAccessibilityTree(
    `button "Send prompt" [ref_3] type="submit" disabled\nbutton "Stop" [ref_4]`,
  );
  assert.equal(nodes[0]!.disabled, true);
  assert.equal(nodes[1]!.disabled, false);
});

test("indentation is preserved as depth", () => {
  const nodes = parseAccessibilityTree(`main\n  article "Reply"\n    button "Copy" [ref_2]`);
  assert.deepEqual(
    nodes.map((node) => node.depth),
    [0, 2, 4],
  );
});

test("an escaped quote inside a name survives parsing", () => {
  const nodes = parseAccessibilityTree(`button "Say \\"hi\\"" [ref_1]`);
  assert.equal(nodes[0]!.name, 'Say "hi"');
});

test("blank lines and an empty tree yield no nodes", () => {
  assert.deepEqual(parseAccessibilityTree("\n\n   \n"), []);
});
