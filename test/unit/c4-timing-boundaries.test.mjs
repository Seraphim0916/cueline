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
let MAX_TIMER_DELAY_MS, validatedTimerDelay, validatedRuntimeHeartbeatInterval, CueLineError;
try {
  ({ MAX_TIMER_DELAY_MS, validatedTimerDelay, validatedRuntimeHeartbeatInterval } =
    await import('../../src/core/timing.ts'));
  ({ CueLineError } = await import('../../src/core/errors.ts'));
} finally {
  hooks.deregister();
}

const maximum = 2_147_483_647;
const invalidValues = [-1, -maximum, -0.5, 0.5, 1.5, NaN, Infinity,
  -Infinity, maximum + 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1];

function assertInvalid(invoke, value, minimum, code, name) {
  assert.throws(() => invoke(value), (error) => {
    assert.ok(error instanceof CueLineError);
    assert.equal(error.name, 'CueLineError');
    assert.equal(error.code, code);
    assert.deepEqual(error.details, { value, minimum, maximum });
    const range = minimum === 0
      ? `an integer between 0 and ${maximum}`
      : `a positive integer no greater than ${maximum}`;
    assert.equal(error.message, `${name} must be ${range}.`);
    return true;
  });
}

test('timer maximum matches the Node signed 32-bit delay limit', () => {
  assert.equal(MAX_TIMER_DELAY_MS, maximum);
});

for (const minimum of [0, 1, undefined]) {
  test(`timer delay boundary matrix: minimum=${minimum ?? 'default'}`, () => {
    const options = { code: 'TEST_DELAY_INVALID', name: 'test delay',
      ...(minimum === undefined ? {} : { minimum }) };
    const invoke = (value) => validatedTimerDelay(value, options);
    const effectiveMinimum = minimum ?? 1;
    for (const value of [1, 2, maximum - 1, maximum,
      ...(effectiveMinimum === 0 ? [0, -0] : [])]) {
      assert.equal(invoke(value), value);
    }
    for (const value of [...invalidValues, ...(effectiveMinimum === 1 ? [0, -0] : [])]) {
      assertInvalid(invoke, value, effectiveMinimum, options.code, options.name);
    }
  });
}

test('runtime heartbeat entry point preserves values and its error contract', () => {
  for (const value of [1, 2, maximum - 1, maximum]) {
    assert.equal(validatedRuntimeHeartbeatInterval(value), value);
  }
  for (const value of [0, -0, ...invalidValues]) {
    assertInvalid(validatedRuntimeHeartbeatInterval, value, 1,
      'RUNTIME_HEARTBEAT_INTERVAL_INVALID', 'runtime heartbeat interval');
  }
});
