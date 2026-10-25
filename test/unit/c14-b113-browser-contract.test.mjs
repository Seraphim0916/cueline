import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const sourceRoot = new URL('../../src/', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot)
        && specifier.startsWith('.') && specifier.endsWith('.js')) {
      return nextResolve(specifier.slice(0, -3) + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
});
let assertBrowserAdapterContract;
try {
  ({ assertBrowserAdapterContract } = await import('../../src/browser/validate-browser-adapter.ts'));
} finally {
  hooks.deregister();
}

class Adapter {
  sendTurn() {}
  submitTurn() {}
  observeTurn() {}
}

test('complete class prototype methods and inherited methods are accepted', () => {
  class InheritedAdapter extends Adapter {}
  for (const adapter of [new Adapter(), new InheritedAdapter()]) {
    assert.deepEqual(Object.keys(adapter), []);
    for (const name of ['sendTurn', 'submitTurn', 'observeTurn']) {
      assert.equal(Object.hasOwn(adapter, name), false);
    }
    assert.doesNotThrow(() => assertBrowserAdapterContract(adapter));
  }
});

test('both split methods omitted or both valid are accepted', () => {
  for (const adapter of [
    { sendTurn() {} },
    { sendTurn() {}, submitTurn: undefined, observeTurn: undefined },
    { sendTurn() {}, submitTurn() {}, observeTurn() {} },
  ]) {
    assert.doesNotThrow(() => assertBrowserAdapterContract(adapter));
  }
});

const fn = () => {};
for (const [label, split, missing] of [
  ['both null', { submitTurn: null, observeTurn: null }, ['submitTurn', 'observeTurn']],
  ['null and omitted', { submitTurn: null }, ['submitTurn', 'observeTurn']],
  ['omitted and null', { observeTurn: null }, ['submitTurn', 'observeTurn']],
  ['valid and null', { submitTurn: fn, observeTurn: null }, ['observeTurn']],
  ['null and valid', { submitTurn: null, observeTurn: fn }, ['submitTurn']],
  ['valid and omitted', { submitTurn: fn }, ['observeTurn']],
  ['omitted and valid', { observeTurn: fn }, ['submitTurn']],
  ['number and string', { submitTurn: 1, observeTurn: 'method' }, ['submitTurn', 'observeTurn']],
  ['boolean and object', { submitTurn: false, observeTurn: {} }, ['submitTurn', 'observeTurn']],
  ['valid and array', { submitTurn: fn, observeTurn: [] }, ['observeTurn']],
]) {
  test(`rejects ${label} with the complete missing-method list`, () => {
    assert.throws(() => assertBrowserAdapterContract({ sendTurn: fn, ...split }), (error) => {
      assert.equal(error.code, 'BROWSER_ADAPTER_INVALID');
      assert.deepEqual(error.details, { missingMethods: missing });
      return true;
    });
  });
}

test('own null methods override valid inherited methods and report all missing methods', () => {
  const adapter = Object.assign(new Adapter(), { sendTurn: null, submitTurn: null, observeTurn: null });
  assert.throws(() => assertBrowserAdapterContract(adapter), (error) => {
    assert.equal(error.code, 'BROWSER_ADAPTER_INVALID');
    assert.deepEqual(error.details, { missingMethods: ['sendTurn', 'submitTurn', 'observeTurn'] });
    return true;
  });
});
