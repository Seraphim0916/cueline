import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
let parseRoutingConfig, loadRoutingConfig;
try {
  ({ parseRoutingConfig, loadRoutingConfig } = await import('../../src/router/config-loader.ts'));
} finally {
  hooks.deregister();
}

const config = (argv) => ({ version: 1, lanes: { default: { enabled: true, candidates: [
  { id: 'first', argv: ['worker'] }, { id: 'second', argv },
] } } });
function invalidNul(error) {
  assert.equal(error.code, 'ROUTING_CONFIG_INVALID');
  assert.match(error.message, /NUL/);
  assert.equal(error.details.lane, 'default');
  assert.equal(error.details.index, 1);
  return true;
}

test('rejects NUL in executable and each later argument with candidate location', () => {
  for (const argv of [['no\0de', 'ok'], ['node', 'abc\0def'], ['node', 'ok', '\0']]) {
    assert.throws(() => parseRoutingConfig(config(argv)), invalidNul);
  }
});

test('JSON escaped NUL is rejected at the real file loading boundary', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'c8-b59-'));
  try {
    const file = path.join(directory, 'routing.json');
    for (const argv of [['no\0de'], ['node', 'abc\0def']]) {
      const source = JSON.stringify(config(argv));
      assert.ok(source.includes('\\u0000'));
      await writeFile(file, source);
      await assert.rejects(loadRoutingConfig(file), invalidNul);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Unicode arguments pass and existing malformed argv restrictions remain', () => {
  const argv = ['執行器', '繁體中文', '🌱', 'a b'];
  assert.deepEqual(parseRoutingConfig(config(argv)).lanes.default.candidates[1].argv, argv);
  for (const invalid of [[], [''], ['node', ''], ['node', 42], 'node']) {
    assert.throws(() => parseRoutingConfig(config(invalid)), { code: 'ROUTING_CONFIG_INVALID' });
  }
});
