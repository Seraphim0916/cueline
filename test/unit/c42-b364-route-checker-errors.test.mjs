import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRoute } from '../../dist/src/router/resolver.js';
import { explainRoutingConfig } from '../../dist/src/router/explain.js';

const config = {
  version: 1,
  lanes: { work: { enabled: true, candidates: ['a', 'b', 'c'].map(id => ({
    id, argv: ['worker', '{task}'],
  })) } },
};

for (const shape of ['function', 'object']) {
  for (const [name, invoke, expected] of [
    ['default route', checker => resolveRoute('work', config, checker), 'a'],
    ['explicit route', checker => resolveRoute('work', config, checker, 'b'), 'b'],
    ['all-lane explanation', checker => explainRoutingConfig(config, checker), 'a'],
    ['selected-lane explanation', checker => explainRoutingConfig(config, checker, 'work'), 'a'],
  ]) {
    test(`${shape}: ${name} propagates the same error and stops probing`, () => {
      const original = new Error('synthetic checker failure');
      const calls = [];
      const probe = (candidate, lane) => {
        calls.push([candidate.id, lane]);
        if (candidate.id === expected) throw original;
        return true;
      };
      const checker = shape === 'function' ? probe : { isAvailable: probe };
      assert.throws(() => invoke(checker), error => {
        assert.strictEqual(error, original);
        return true;
      });
      assert.deepEqual(calls, [[expected, 'work']]);
    });
  }
}
