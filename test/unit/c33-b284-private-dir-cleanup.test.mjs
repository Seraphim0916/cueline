import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as vm from 'node:vm';

if (!vm.SourceTextModule) {
  test('private directory cleanup with VM modules', () => {
    const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--test', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 30_000 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });
} else {
  async function fixture(failure, closeFails) {
    const context = vm.createContext({});
    const load = async (name) => new vm.SourceTextModule(stripTypeScriptTypes(await readFile(new URL(name, import.meta.url), 'utf8')), { context });
    const errors = await load('../../src/core/errors.ts');
    const cause = new Error(`${failure} failed`);
    const calls = [];
    const dependencies = {
      'node:fs': { constants },
      '../core/runtime.js': { runtimePlatform: () => 'darwin' },
      'node:fs/promises': {
        mkdir: async () => '/virtual/private',
        lstat: async () => { assert.fail('POSIX must use descriptor stat'); },
        open: async () => ({
          stat: async () => { calls.push('stat'); if (failure === 'stat') throw cause; return { isDirectory: () => true }; },
          chmod: async (mode) => { calls.push('chmod'); assert.equal(mode, 0o700); if (failure === 'chmod') throw cause; },
          close: async () => { calls.push('close'); if (closeFails) throw new Error('close failed'); },
        }),
      },
    };
    const subject = await load('../../src/state/private-directory.ts');
    await subject.link((specifier) => {
      if (specifier === '../core/errors.js') return errors;
      const exports = dependencies[specifier];
      assert.ok(exports, specifier);
      return new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      }, { context });
    });
    await subject.evaluate();
    return { run: subject.namespace.ensurePrivateDirectory, cause, calls };
  }
  for (const failure of ['stat', 'chmod']) {
    for (const closeFails of [false, true]) {
      test(`${failure} failure preserves cause and closes once; closeFails=${closeFails}`, async () => {
        const f = await fixture(failure, closeFails);
        await assert.rejects(f.run('/virtual/private'), (error) => {
          assert.equal(error.code, 'PRIVATE_STATE_DIRECTORY_INVALID');
          assert.equal(error.cause, f.cause);
          return true;
        });
        assert.deepEqual(f.calls, failure === 'stat' ? ['stat', 'close'] : ['stat', 'chmod', 'close']);
      });
    }
  }
  for (const closeFails of [false, true]) {
    test(`successful validation returns created directory and closes once; closeFails=${closeFails}`, async () => {
      const f = await fixture(undefined, closeFails);
      assert.equal(await f.run('/virtual/private'), '/virtual/private');
      assert.deepEqual(f.calls, ['stat', 'chmod', 'close']);
    });
  }
}
