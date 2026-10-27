import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as vm from 'node:vm';

if (!vm.SourceTextModule) {
  test('atomic write compiled module checks', () => {
    const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--test', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 30_000 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });
} else {
  async function load(fs) {
    const context = vm.createContext({});
    const dependencies = {
      'node:crypto': { randomUUID: () => 'uuid' },
      'node:path': { default: path },
      '../core/ids.js': { canonicalJson: JSON.stringify },
      '../core/runtime.js': { runtimePidTag: () => 'pid', runtimePlatform: () => 'darwin' },
      './private-directory.js': { ensurePrivateDirectory: async () => undefined },
      'node:fs/promises': fs,
    };
    const subject = new vm.SourceTextModule(await readFile(new URL('../../dist/src/state/atomic-write.js', import.meta.url), 'utf8'), { context });
    await subject.link((specifier) => {
      const exports = dependencies[specifier];
      assert.ok(exports, specifier);
      return new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      }, { context });
    });
    await subject.evaluate();
    return subject.namespace;
  }
  const target = path.join(tmpdir(), 'c45-record.json');
  const temporary = path.join(path.dirname(target), '.c45-record.json.pid.uuid.tmp');

  for (const entry of ['atomicWriteJson', 'atomicCreateJson']) {
    for (const failure of ['publish', 'write']) {
      for (const secondary of ['none', 'close', 'unlink', 'both']) {
        // A publish failure happens after the file handle is already closed.
        if (failure === 'publish' && ['close', 'both'].includes(secondary)) continue;
        test(`${entry}: ${failure} failure survives ${secondary} cleanup failure`, async (t) => {
          const original = new Error('original failure');
          const cleanup = new Error('cleanup failure');
          const files = new Map([[target, 'original target']]);
          const calls = [];
          let published = false;
          const publish = async (from, to) => {
            calls.push(entry === 'atomicWriteJson' ? 'rename' : 'link');
            assert.equal(from, temporary);
            assert.equal(to, target);
            throw original;
          };
          const api = await load({
            open: async (name, flags) => {
              assert.equal(name, temporary);
              assert.equal(flags, 'wx');
              files.set(name, '');
              return {
                writeFile: async (data) => {
                  calls.push('write');
                  if (failure === 'write') throw original;
                  files.set(name, data);
                },
                sync: async () => { calls.push('sync'); },
                close: async () => {
                  calls.push('close');
                  if (['close', 'both'].includes(secondary)) throw cleanup;
                },
              };
            },
            rename: publish,
            link: publish,
            unlink: async (name) => {
              calls.push('unlink');
              assert.equal(name, temporary);
              if (['unlink', 'both'].includes(secondary)) throw cleanup;
              files.delete(name);
            },
          });
          await assert.rejects(api[entry](target, { ok: true }), (error) => error === original);
          assert.deepEqual(calls, failure === 'write'
            ? ['write', 'close', 'unlink']
            : ['write', 'sync', 'close', entry === 'atomicWriteJson' ? 'rename' : 'link', 'unlink']);
          assert.equal(files.get(target), 'original target');
          published = files.get(target) !== 'original target';
          assert.equal(published, false);
          assert.equal(files.has(temporary), ['unlink', 'both'].includes(secondary));
          t.diagnostic('same-error=true, published=false');
        });
      }
    }
  }
}

