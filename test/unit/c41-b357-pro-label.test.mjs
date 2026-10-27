import assert from 'node:assert/strict';
import test from 'node:test';
import { isProLabel } from '../../dist/src/browser/codex-iab/recovery-evidence.js';

test('labels [true,true,true,false,false,false]', () => {
  const results = ['Pro', 'Pro Standard', 'Pro Extended', 'Pro Plus', 'GPT-5 Pro', null].map(isProLabel);
  assert.deepEqual(results, [true, true, true, false, false, false]);
  console.log('labels', results);
});

for (const label of ['pro', 'PRO', 'pRo sTaNdArD', 'PRO EXTENDED',
  'Pro  Standard', 'Pro\tExtended', 'Pro\nStandard', 'Pro\u00a0Extended']) {
  test(`accept existing case and separator semantics: ${JSON.stringify(label)}`, () => {
    assert.equal(isProLabel(label), true);
  });
}

for (const label of ['', null, undefined, ' Pro', 'Pro ', ' Pro Standard',
  'Pro Standard ', 'ProStandard', 'ProExtended', 'Pro-Extended',
  'Pro Plus', 'Plus', 'Team', 'Enterprise', 'GPT-5 Pro', 'GPT-5.2 Pro',
  'Pro Standard Extended']) {
  test(`reject non-label or missing value: ${JSON.stringify(label)}`, () => {
    assert.equal(isProLabel(label), false);
  });
}
