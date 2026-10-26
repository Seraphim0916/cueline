import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as vm from 'node:vm';

if (!vm.SourceTextModule) {
  test('temporary ownership with VM modules', () => {
    const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--test', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 30_000 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });
} else {
  async function fixture(failure) {
    const context = vm.createContext({});
    const cause = Object.assign(new Error(failure), { code: failure });
    const files = new Map([['/state/record.json', 'original']]);
    const temporary = '/state/.record.json.pid.uuid.tmp';
    if (failure === 'EEXIST' || failure === 'EACCES') files.set(temporary, 'foreign');
    const calls = { unlinks: [], closes: 0 };
    const dependencies = {
      'node:crypto': { randomUUID: () => 'uuid' },
      'node:path': { default: path },
      '../core/ids.js': { canonicalJson: JSON.stringify },
      '../core/runtime.js': { runtimePidTag: () => 'pid', runtimePlatform: () => 'darwin' },
      './private-directory.js': { ensurePrivateDirectory: async () => undefined },
      'node:fs/promises': {
        open: async (name, flags, mode) => {
          if (flags === 'r') return { sync: async () => { if (failure === 'directory-sync') throw cause; }, close: async () => {} };
          assert.equal(flags, 'wx');
          assert.equal(mode, 0o600);
          if (failure === 'EEXIST' || failure === 'EACCES') throw cause;
          files.set(name, '');
          return {
            writeFile: async (data) => { if (failure === 'write') throw cause; files.set(name, data); },
            sync: async () => {},
            close: async () => { calls.closes++; },
          };
        },
        rename: async (from, to) => {
          files.set(to, files.get(from));
          files.delete(from);
          // Another creator reuses the name after ownership was transferred.
          if (failure === 'directory-sync') files.set(from, 'foreign replacement');
        },
        link: async (from, to) => {
          if (failure === 'collision') throw Object.assign(new Error('collision'), { code: 'EEXIST' });
          files.set(to, files.get(from));
        },
        unlink: async (name) => { calls.unlinks.push(name); files.delete(name); },
      },
    };
    const subject = new vm.SourceTextModule(stripTypeScriptTypes(await readFile(new URL('../../src/state/atomic-write.ts', import.meta.url), 'utf8')), { context });
    await subject.link((specifier) => {
      const exports = dependencies[specifier];
      assert.ok(exports, specifier);
      return new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      }, { context });
    });
    await subject.evaluate();
    return { api: subject.namespace, cause, calls, files, temporary };
  }

  for (const entry of ['atomicWriteJson', 'atomicCreateJson']) {
    for (const code of ['EEXIST', 'EACCES']) {
      test(`${entry}: failed open ${code} preserves foreign temporary and error`, async () => {
        const f = await fixture(code);
        await assert.rejects(f.api[entry]('/state/record.json', { ok: true }), (error) => error === f.cause);
        assert.deepEqual(f.calls.unlinks, []);
        assert.equal(f.files.get(f.temporary), 'foreign');
        assert.equal(f.files.get('/state/record.json'), 'original');
        assert.equal(f.calls.closes, 0);
      });
    }
    test(`${entry}: write failure cleans owned temporary exactly once`, async () => {
      const f = await fixture('write');
      await assert.rejects(f.api[entry]('/state/record.json', {}), (error) => error === f.cause);
      assert.deepEqual(f.calls.unlinks, [f.temporary]);
      assert.equal(f.calls.closes, 1);
      assert.equal(f.files.has(f.temporary), false);
      assert.equal(f.files.get('/state/record.json'), 'original');
    });
    test(`${entry}: successful write leaves no temporary`, async () => {
      const f = await fixture('success');
      assert.equal(await f.api[entry]('/state/record.json', { ok: true }), entry === 'atomicCreateJson' ? true : undefined);
      assert.equal(f.files.get('/state/record.json'), '{"ok":true}\n');
      assert.equal(f.files.has(f.temporary), false);
      assert.equal(f.calls.closes, 1);
    });
  }
  test('atomicCreateJson: target collision returns false and removes only owned temporary', async () => {
    const f = await fixture('collision');
    assert.equal(await f.api.atomicCreateJson('/state/record.json', {}), false);
    assert.equal(f.files.get('/state/record.json'), 'original');
    assert.deepEqual(f.calls.unlinks, [f.temporary]);
    assert.equal(f.calls.closes, 1);
  });
  test('atomicWriteJson: sync failure after rename does not unlink a replacement', async () => {
    const f = await fixture('directory-sync');
    await assert.rejects(f.api.atomicWriteJson('/state/record.json', {}), (error) => error === f.cause);
    assert.deepEqual(f.calls.unlinks, []);
    assert.equal(f.files.get(f.temporary), 'foreign replacement');
    assert.equal(f.files.get('/state/record.json'), '{}\n');
  });
}
