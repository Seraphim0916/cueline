import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const asModule = source => `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`;
const errors = asModule(await readFile(new URL('../../src/core/errors.ts', import.meta.url), 'utf8'));
const source = await readFile(new URL('../../src/router/config-loader.ts', import.meta.url), 'utf8');
const { parseRoutingConfig } = await import(asModule(source.replace('../core/errors.js', errors)));
const candidate = id => ({ id, argv: ['worker', '{task}', '--flag'], task_input: 'argv' });
const config = candidates => ({ version: 1, lanes: { default: { enabled: true, candidates } } });

for (const field of ['argv', 'candidates']) {
  for (const index of [0, 1, 2]) {
    test(`${field} rejects a hole at index ${index} through the public parser`, () => {
      const candidates = ['first', 'middle', 'last'].map(candidate);
      delete (field === 'argv' ? candidates[0].argv : candidates)[index];
      assert.throws(() => parseRoutingConfig(config(candidates)), {
        name: 'CueLineError', code: 'ROUTING_CONFIG_INVALID',
      });
    });
  }
}

test('dense candidates preserve identifiers, templates, and order', () => {
  const input = config(['first', 'middle', 'last'].map(candidate));
  assert.deepEqual(parseRoutingConfig(input), input);
});
