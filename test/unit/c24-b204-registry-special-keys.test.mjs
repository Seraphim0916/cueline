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

const names = ['__proto__', 'constructor', 'toString'];
for (const name of names) {
  test(`${name} is absent until explicitly registered`, () => {
    const registry = new RunnerRegistry([{ id: 'ordinary', executable: 'ordinary' }]);
    assert.equal(registry.get(name), undefined);
    assert.equal(registry.hasExecutable(name), false);
    assert.throws(() => registry.requireExecutable(name), { code: 'RUNNER_EXECUTABLE_UNREGISTERED' });
    assert.throws(() => registry.requireArgv([name]), { code: 'RUNNER_EXECUTABLE_UNREGISTERED' });
  });
}

for (const mode of ['constructor', 'register']) {
  test(`${mode} preserves distinct special keys and rejects duplicates in both indexes`, () => {
    // Rotate executable names so an accidental lookup in the ID index cannot pass.
    const entries = names.map((id, index) => ({ id, executable: names[(index + 1) % names.length] }));
    const registry = new RunnerRegistry(mode === 'constructor' ? entries : []);
    if (mode === 'register') for (const entry of entries) registry.register(entry);
    for (const entry of entries) {
      assert.deepEqual(registry.get(entry.id), entry);
      assert.equal(registry.hasExecutable(entry.executable), true);
      assert.deepEqual(registry.requireExecutable(entry.executable), entry);
      assert.deepEqual(registry.requireArgv([entry.executable, '--version']), entry);
      assert.throws(() => registry.register({ id: entry.id, executable: 'fresh-executable' }),
        { code: 'RUNNER_REGISTRY_DUPLICATE' });
      assert.throws(() => registry.register({ id: 'fresh-id', executable: entry.executable }),
        { code: 'RUNNER_REGISTRY_DUPLICATE' });
      assert.deepEqual(registry.requireArgv([entry.executable]), entry);
    }
    assert.equal(registry.get('fresh-id'), undefined);
    assert.equal(registry.hasExecutable('fresh-executable'), false);
  });
}
