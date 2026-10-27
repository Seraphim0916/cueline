import assert from 'node:assert/strict';
import test from 'node:test';
import { exactAccessibilityControllerEnvelopeText } from '../../dist/src/browser/codex-iab/recovery-evidence.js';

const identity = { runId: 'run-b355', round: 3, requestId: 'request-b355' };
const envelope = `<CueLineControl>${JSON.stringify({
  protocol: 'cueline/0.1', run_id: identity.runId,
  round: identity.round, request_id: identity.requestId,
})}</CueLineControl>`;
const read = (lines) => exactAccessibilityControllerEnvelopeText(lines.join('\n'), identity);

test('assistant scope [false,true,false]: user, assistant, adjacent user', () => {
  const snapshots = [
    ['- article "You said:"', `  - paragraph: ${envelope}`],
    ['- article "ChatGPT said:"', `  - paragraph: ${envelope}`],
    ['- article "ChatGPT said:"', '  - paragraph: Waiting.',
      '- article "You said:"', `  - paragraph: ${envelope}`],
  ];
  const results = snapshots.map(read);
  assert.deepEqual(results, [null, envelope, null]);
  console.log('assistant scope', results.map(value => value !== null));
});

test('assistant heading is scoped to its own article', () => {
  assert.equal(read(['- article:', '  - heading "ChatGPT said:"',
    `  - paragraph: ${envelope}`]), envelope);
  assert.equal(read(['- article "You said:"', `  - paragraph: ${envelope}`,
    '- article:', '  - heading "ChatGPT said:"', '  - paragraph: Waiting.']), null);
  assert.equal(read(['- article "ChatGPT said:"', `  - paragraph: ${envelope}`,
    '- article "You said:"', '  - paragraph: Follow-up.']), envelope);
});

test('same-indent and dedented siblings terminate assistant scope', () => {
  assert.equal(read(['- main:', '  - article "ChatGPT said:"', '',
    `    - paragraph: ${envelope}`]), envelope);
  for (const siblingIndent of ['  ', '']) {
    assert.equal(read(['- main:', '  - article "ChatGPT said:"',
      '    - paragraph: Waiting.', '', `${siblingIndent}- paragraph: ${envelope}`]), null);
  }
  assert.equal(read(['- main:', '  - article "ChatGPT said:"',
    '    - paragraph: Waiting.', '  - article "You said:"',
    `    - paragraph: ${envelope}`]), null);
});
