import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const dataUrl = source => `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`;
const errors = dataUrl(await readFile(new URL('../../src/core/errors.ts', import.meta.url), 'utf8'));
const resolver = dataUrl((await readFile(new URL('../../src/router/resolver.ts', import.meta.url), 'utf8'))
  .replace('"../core/errors.js"', JSON.stringify(errors)));
const { explainRoutingConfig } = await import(dataUrl(
  (await readFile(new URL('../../src/router/explain.ts', import.meta.url), 'utf8'))
    .replace('"./resolver.js"', JSON.stringify(resolver))));

test('explanation probes every enabled fallback once after selecting the first available', () => {
  const candidates = [
    { id: 'disabled', enabled: false, argv: ['disabled'] },
    { id: 'first', argv: ['first'] },
    { id: 'later', enabled: true, argv: ['later'] },
    { id: 'missing', enabled: true, argv: ['missing'] },
  ];
  const calls = [];
  const result = explainRoutingConfig({ lanes: { work: { enabled: true, candidates } } },
    (candidate, lane) => {
      calls.push([candidate.id, lane]);
      assert.strictEqual(candidate, candidates.find(entry => entry.id === candidate.id));
      assert.notEqual(candidate.id, 'disabled');
      return candidate.id !== 'missing';
    }, 'work');
  assert.deepEqual(calls, [['first', 'work'], ['later', 'work'], ['missing', 'work']]);
  assert.equal(result.lanes.length, 1);
  const lane = result.lanes[0];
  assert.equal(lane.selectedRunnerId, 'first');
  assert.equal(lane.status, 'available');
  assert.deepEqual(lane.candidates, [
    { id: 'disabled', index: 0, enabled: false, available: null, selected: false, reasonCode: 'RUNNER_DISABLED' },
    { id: 'first', index: 1, enabled: true, available: true, selected: true, reasonCode: 'SELECTED_FIRST_AVAILABLE' },
    { id: 'later', index: 2, enabled: true, available: true, selected: false, reasonCode: 'AVAILABLE_FALLBACK' },
    { id: 'missing', index: 3, enabled: true, available: false, selected: false, reasonCode: 'RUNNER_UNAVAILABLE' },
  ]);
  assert.deepEqual(lane.candidates.filter(candidate => candidate.selected).map(candidate => candidate.id), ['first']);
});
