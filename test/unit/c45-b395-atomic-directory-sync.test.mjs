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
    test(`${entry}: directory sync failure rejects after publication without removing target`, async (t) => {
      const original = new Error('directory sync failure');
      const files = new Map();
      const events = [];
      const unlinked = [];
      const publish = (from, to, move) => {
        assert.equal(from, temporary);
        assert.equal(to, target);
        assert.ok(files.has(from));
        files.set(to, files.get(from));
        if (move) files.delete(from);
        events.push(move ? 'rename' : 'link');
      };
      const api = await load({
        open: async (name, flags) => {
          if (flags === 'r') {
            assert.equal(name, path.dirname(target));
            events.push('open-dir');
            return {
              sync: async () => {
                events.push('sync-dir');
                assert.equal(files.get(target), '{"ok":true}\n');
                throw original;
              },
              close: async () => { events.push('close-dir'); },
            };
          }
          assert.equal(name, temporary);
          assert.equal(flags, 'wx');
          files.set(name, '');
          return {
            writeFile: async (data) => { files.set(name, data); },
            sync: async () => {},
            close: async () => {},
          };
        },
        rename: async (from, to) => publish(from, to, true),
        link: async (from, to) => publish(from, to, false),
        unlink: async (name) => {
          unlinked.push(name);
          events.push('unlink-temp');
          files.delete(name);
        },
      });
      await assert.rejects(api[entry](target, { ok: true }), (error) => error === original);
      assert.equal(files.get(target), '{"ok":true}\n');
      assert.equal(files.has(temporary), false);
      assert.deepEqual(unlinked, entry === 'atomicCreateJson' ? [temporary] : []);
      assert.deepEqual(events, entry === 'atomicCreateJson'
        ? ['link', 'open-dir', 'sync-dir', 'close-dir', 'unlink-temp']
        : ['rename', 'open-dir', 'sync-dir', 'close-dir']);
      t.diagnostic('same-error=true, published=true; ' + events.join(','));
    });
  }
}

