import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const dataUrl = source => `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`;
const read = relative => readFile(new URL(relative, import.meta.url), 'utf8');
const errors = dataUrl(await read('../../src/core/errors.ts'));
const resolver = dataUrl((await read('../../src/router/resolver.ts')).replace('"../core/errors.js"', JSON.stringify(errors)));
const source = (await read('../../src/router/explain.ts')).replace('"./resolver.js"', JSON.stringify(resolver));
const { explainRoutingConfig } = await import(dataUrl(source));
const lane = () => ({ enabled: true, candidates: [{ id: 'runner', argv: ['runner'] }] });

test('inherited lanes and prototype names are unknown without probing', () => {
  const prototype = { hidden: lane() };
  Object.defineProperty(prototype, '__proto__', { value: lane(), enumerable: true });
  const inherited = Object.create(prototype);
  for (const lanes of [inherited, {}, Object.create(null)]) {
    let calls = 0;
    for (const name of ['hidden', 'toString', 'constructor', '__proto__']) {
      assert.equal(Object.hasOwn(lanes, name), false);
      const result = explainRoutingConfig({ version: 1, lanes }, () => { calls += 1; return true; }, name);
      assert.deepEqual(result, {
        requestedLane: name, availableLanes: 0, lanes: [],
        findings: [{ code: 'ROUTE_LANE_UNKNOWN', message: 'Requested lane is not configured.' }],
      });
      assert.equal(calls, 0, `${name} must not probe runners`);
    }
  }
  console.log('hidden, toString, constructor, inherited __proto__: ROUTE_LANE_UNKNOWN; calls 0');
});

test('explicit own special lanes work on ordinary and null-prototype objects', () => {
  for (const lanes of [{}, Object.create(null)]) {
    for (const name of ['__proto__', 'hidden', 'toString', 'constructor']) {
      const configured = lane();
      Object.defineProperty(lanes, name, { value: configured, enumerable: true });
      assert.equal(Object.hasOwn(lanes, name), true);
      let calls = 0;
      const result = explainRoutingConfig({ version: 1, lanes }, (candidate, laneName) => {
        calls += 1;
        assert.equal(candidate, configured.candidates[0]);
        assert.equal(laneName, name);
        return true;
      }, name);
      assert.equal(calls, 1);
      assert.equal(result.requestedLane, name);
      assert.equal(result.availableLanes, 1);
      assert.deepEqual(result.findings, []);
      assert.equal(result.lanes.length, 1);
      assert.equal(result.lanes[0].name, name);
      assert.equal(result.lanes[0].status, 'available');
      assert.equal(result.lanes[0].selectedRunnerId, 'runner');
      assert.equal(result.lanes[0].candidates[0].reasonCode, 'SELECTED_FIRST_AVAILABLE');
      if (name === '__proto__') console.log(`own special lane ok calls ${calls}`);
    }
  }
});
