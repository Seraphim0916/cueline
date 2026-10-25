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
let RunnerRegistry;
try {
  ({ RunnerRegistry } = await import('../../src/runners/registry.ts'));
} finally {
  hooks.deregister();
}

const original = { id: 'fixture', executable: '/fixture/original' };
const readers = {
  get: registry => registry.get(original.id),
  requireExecutable: registry => registry.requireExecutable(original.executable),
  requireArgv: registry => registry.requireArgv([original.executable, '--version']),
};

for (const [name, read] of Object.entries(readers)) {
  test(`${name} returns a copy without corrupting either index`, () => {
    const registry = new RunnerRegistry([original]);
    const result = read(registry);
    result.id = 'changed';
    result.executable = '/fixture/other';
    for (const lookup of Object.values(readers)) {
      assert.deepEqual(lookup(registry), original);
      assert.notStrictEqual(lookup(registry), lookup(registry));
    }
    assert.equal(registry.get('changed'), undefined);
    assert.equal(registry.hasExecutable(original.executable), true);
    assert.equal(registry.hasExecutable('/fixture/other'), false);
    assert.throws(() => registry.requireExecutable('/fixture/other'),
      { code: 'RUNNER_EXECUTABLE_UNREGISTERED' });
    assert.throws(() => registry.register({ ...original, executable: '/fixture/new' }),
      { code: 'RUNNER_REGISTRY_DUPLICATE' });
    assert.throws(() => registry.register({ ...original, id: 'new' }),
      { code: 'RUNNER_REGISTRY_DUPLICATE' });
    assert.deepEqual(registry.get(original.id), original);
  });
}

test('constructor and register isolate original inputs and retain rejection behavior', () => {
  for (const construct of [entry => new RunnerRegistry([entry]),
    entry => new RunnerRegistry().register(entry)]) {
    const input = { ...original };
    const registry = construct(input);
    input.id = 'changed';
    input.executable = '/fixture/other';
    for (const read of Object.values(readers)) assert.deepEqual(read(registry), original);
    assert.equal(registry.get('missing'), undefined);
    assert.throws(() => registry.requireArgv([]), { code: 'RUNNER_ARGV_INVALID' });
    assert.throws(() => registry.requireArgv(['/fixture/other']),
      { code: 'RUNNER_EXECUTABLE_UNREGISTERED' });
  }
});
