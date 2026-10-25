import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = stripTypeScriptTypes(await readFile(
  new URL('../../src/core/runtime.ts', import.meta.url), 'utf8',
)).replace(/^import\b[\s\S]*?;\n/gm, '').replace(/^export /gm, '');

function runtime(globals = {}) {
  return runInNewContext(`${source}\n({ runtimeCwd, runtimeEnvironment, runtimePidTag, runtimePlatform })`,
    { path, randomUUID, ...globals });
}

for (const [name, nodeRepl, cwd] of [
  ['no runtime metadata', undefined, '.'],
  ['empty runtime metadata', {}, '.'],
  ['home only', { homeDir: '/fixture/home' }, '/fixture/home'],
  ['cwd only', { cwd: '/fixture/work' }, '/fixture/work'],
  ['cwd wins over home', { cwd: '/fixture/work', homeDir: '/fixture/home' }, '/fixture/work'],
]) {
  test(`without process: ${name}`, () => {
    const api = runtime({ nodeRepl });
    assert.equal(api.runtimeCwd(), cwd);
    const env = api.runtimeEnvironment();
    assert.equal(Object.hasOwn(env, 'HOME'), nodeRepl?.homeDir !== undefined);
    assert.equal(env.HOME, nodeRepl?.homeDir);
    assert.equal(env.PATH, [
      ...(nodeRepl?.homeDir === undefined ? [] : [path.join(nodeRepl.homeDir, '.local', 'bin')]),
      '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
    ].join(path.delimiter));
  });
}

test('native process wins and preserves the environment object identity', () => {
  const env = { HOME: '/native/home', PATH: '/native/bin' };
  const api = runtime({
    process: { env, cwd: () => '/native', pid: 42, platform: 'darwin' },
    nodeRepl: { cwd: '/fixture/work', homeDir: '/fixture/home' },
  });
  assert.equal(api.runtimeCwd(), '/native');
  assert.strictEqual(api.runtimeEnvironment(), env);
  assert.equal(api.runtimePidTag(), '42');
  assert.equal(api.runtimePlatform(), 'darwin');
});
