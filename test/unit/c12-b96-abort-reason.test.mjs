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
let throwIfCancelled, CueLineError;
try {
  ({ throwIfCancelled } = await import('../../src/core/controller-abort.ts'));
  ({ CueLineError } = await import('../../src/core/errors.ts'));
} finally {
  hooks.deregister();
}

test('missing and non-aborted signals return normally', () => {
  assert.equal(throwIfCancelled(undefined), undefined);
  assert.equal(throwIfCancelled(new AbortController().signal), undefined);
});

test('an existing CueLineError is thrown by identity without wrapping', () => {
  const reason = new CueLineError('FIXTURE_CANCEL', 'fixture', {
    cause: { original: true }, details: { fixture: true },
  });
  const controller = new AbortController();
  controller.abort(reason);
  assert.throws(() => throwIfCancelled(controller.signal), (error) => {
    assert.strictEqual(error, reason);
    return true;
  });
});

for (const [name, reason] of [
  ['string', 'fixture'], ['Error', new Error('fixture')], ['object', { fixture: true }],
]) {
  test(`${name} reasons are wrapped as RUN_CANCELLED with the original cause`, () => {
    const controller = new AbortController();
    controller.abort(reason);
    assert.throws(() => throwIfCancelled(controller.signal), (error) => {
      assert.ok(error instanceof CueLineError);
      assert.equal(error.code, 'RUN_CANCELLED');
      assert.notStrictEqual(error, reason);
      assert.strictEqual(error.cause, reason);
      return true;
    });
  });
}
