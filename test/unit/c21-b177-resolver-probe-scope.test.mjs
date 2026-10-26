import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const asModule = source => `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`;
const errors = asModule(await readFile(new URL('../../src/core/errors.ts', import.meta.url), 'utf8'));
const source = await readFile(new URL('../../src/router/resolver.ts', import.meta.url), 'utf8');
const { resolveRoute } = await import(asModule(source.replace('../core/errors.js', errors)));
const candidates = ['disabled', 'first', 'later'].map(id => ({
  id, argv: ['worker', '{task}'], ...(id === 'disabled' ? { enabled: false } : {}),
}));
const config = { version: 1, lanes: { default: { enabled: true, candidates } } };

for (const shape of ['function', 'checker']) {
  const wrap = probe => shape === 'function' ? probe : { isAvailable: probe };
  test(`${shape}: auto skips disabled and stops at first available candidate`, () => {
    const probes = [];
    const result = resolveRoute('default', config, wrap((candidate, lane) => {
      probes.push(candidate.id);
      assert.equal(lane, 'default');
      if (candidate.id !== 'first') throw new Error(`Unexpected probe: ${candidate.id}`);
      return true;
    }));
    assert.equal(result.candidate, candidates[1]);
    assert.equal(result.candidateIndex, 1);
    assert.deepEqual(probes, ['first']);
  });

  test(`${shape}: explicit unavailable candidate never probes a fallback`, () => {
    const probes = [];
    assert.throws(() => resolveRoute('default', config, wrap((candidate, lane) => {
      probes.push(candidate.id);
      assert.equal(lane, 'default');
      if (candidate.id !== 'later') throw new Error(`Unexpected probe: ${candidate.id}`);
      return false;
    }), 'later'), { name: 'CueLineError', code: 'ROUTE_RUNNER_UNAVAILABLE' });
    assert.deepEqual(probes, ['later']);
  });

  test(`${shape}: explicit disabled candidate is rejected without any probe`, () => {
    const probes = [];
    assert.throws(() => resolveRoute('default', config, wrap(candidate => {
      probes.push(candidate.id);
      throw new Error(`Unexpected probe: ${candidate.id}`);
    }), 'disabled'), { name: 'CueLineError', code: 'ROUTE_RUNNER_DISABLED' });
    assert.deepEqual(probes, []);
  });
}
