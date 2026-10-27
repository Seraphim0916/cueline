import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRoutingConfig } from '../../dist/src/router/config-loader.js';

const fixture = () => ({ version: 1, lanes: { work: {
  enabled: true,
  candidates: [{ id: 'worker', argv: ['worker', '{task}'], task_input: 'argv', enabled: true }],
} } });

const mutations = [
  ['lane map', config => { config.lanes.extra = { enabled: false, candidates: [] }; }],
  ['lane', config => { config.lanes.work.enabled = false; }],
  ['candidate list', config => { config.lanes.work.candidates.push({ id: 'extra', argv: ['other'] }); }],
  ['candidate', config => { config.lanes.work.candidates[0].id = 'changed'; }],
  ['arguments', config => { config.lanes.work.candidates[0].argv[1] = 'changed'; }],
];

for (const [name, mutate] of mutations) {
  test(`${name}: changing a parsed result leaves source and another parse intact`, () => {
    const source = fixture();
    const first = parseRoutingConfig(source);
    const second = parseRoutingConfig(source);
    mutate(first);
    assert.notDeepEqual(first, fixture());
    assert.deepEqual(source, fixture());
    assert.deepEqual(second, fixture());
    assert.deepEqual(parseRoutingConfig(source), fixture());
  });

  test(`${name}: changing the source leaves both parsed results intact`, () => {
    const source = fixture();
    const first = parseRoutingConfig(source);
    const second = parseRoutingConfig(source);
    mutate(source);
    assert.notDeepEqual(source, fixture());
    assert.deepEqual(first, fixture());
    assert.deepEqual(second, fixture());
  });
}
