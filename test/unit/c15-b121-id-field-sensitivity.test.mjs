import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = await readFile(new URL('../../src/core/ids.ts', import.meta.url), 'utf8');
const { jobId, messageId } = await import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`);

test('job IDs retain run and spec differences while ignoring object key order', () => {
  const spec = { task: 'inspect', options: { depth: 2, verbose: false } };
  const baseline = jobId('run_a', 'inspect', spec);
  const changedRun = jobId('run_b', 'inspect', spec);
  const changedSpec = jobId('run_a', 'inspect', { ...spec, options: { ...spec.options, depth: 3 } });
  assert.notEqual(baseline, changedRun, 'run ID participates in job identity');
  assert.notEqual(baseline, changedSpec, 'nested spec participates in job identity');
  assert.equal(new Set([baseline, changedRun, changedSpec]).size, 3);
  assert.equal(baseline, jobId('run_a', 'inspect', { options: { verbose: false, depth: 2 }, task: 'inspect' }));
  console.log('job unique 3');
});

test('message IDs retain run, round, direction and content differences', () => {
  const content = { text: 'hello', metadata: { a: 1, b: 2 } };
  const baseline = messageId('run_a', 2, 'controller', content);
  const variants = [
    ['run', messageId('run_b', 2, 'controller', content)],
    ['round', messageId('run_a', 3, 'controller', content)],
    ['direction', messageId('run_a', 2, 'observation', content)],
    ['content', messageId('run_a', 2, 'controller', { ...content, text: 'goodbye' })],
  ];
  for (const [field, id] of variants) assert.notEqual(baseline, id, `${field} participates in message identity`);
  assert.equal(new Set([baseline, ...variants.map(([, id]) => id)]).size, 5);
  assert.equal(baseline, messageId('run_a', 2, 'controller', { metadata: { b: 2, a: 1 }, text: 'hello' }));
  console.log('message unique 5');
});
