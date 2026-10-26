import assert from 'node:assert/strict';
import test from 'node:test';
import { isProModelSlug } from '../../dist/src/browser/codex-iab/recovery-evidence.js';

const accepted = [
  'gpt-5-pro', 'GPT-5.2-PRO', 'gpt-5-2-pro', 'GpT-5.2-pRo',
  'gpt-5.2.1-pro', 'gpt-5-2-1-pro', 'gpt-5.2-1-pro',
  // The current contract recognizes syntax, not a released-model allowlist.
  'gpt-12-pro', 'gpt-05.02-pro',
];
const rejected = [
  'gpt-5.2-pro-preview', 'gpt-5.2-pro-extended', 'gpt-5.2',
  'gpt-5', 'gpt-5.2-preview', 'o3-pro', 'claude-5-pro', null,
];

for (const slug of accepted) {
  test(`accepts existing Pro syntax: ${slug}`, () => {
    assert.equal(isProModelSlug(slug), true);
    console.log(String(slug), isProModelSlug(slug));
  });
}
for (const slug of rejected) {
  test(`rejects non-Pro identity: ${slug}`, () => {
    assert.equal(isProModelSlug(slug), false);
    console.log(String(slug), isProModelSlug(slug));
  });
}
