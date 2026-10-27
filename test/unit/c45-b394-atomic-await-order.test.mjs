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

  function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  }

  for (const entry of ['atomicWriteJson', 'atomicCreateJson']) {
    test(`${entry}: publication awaits file sync and close`, async (t) => {
      const syncEntered = deferred();
      const syncRelease = deferred();
      const closeEntered = deferred();
      const closeRelease = deferred();
      const events = [];
      const publication = entry === 'atomicWriteJson' ? 'rename' : 'link';
      const api = await load({
        open: async (name, flags) => {
          if (flags === 'r') {
            assert.equal(name, path.dirname(target));
            return { sync: async () => {}, close: async () => {} };
          }
          assert.equal(name, temporary);
          assert.equal(flags, 'wx');
          return {
            writeFile: async () => { events.push('write'); },
            sync: async () => {
              events.push('sync');
              syncEntered.resolve();
              await syncRelease.promise;
            },
            close: async () => {
              events.push('close');
              closeEntered.resolve();
              await closeRelease.promise;
            },
          };
        },
        rename: async () => { events.push('rename'); },
        link: async () => { events.push('link'); },
        unlink: async (name) => { assert.equal(name, temporary); },
      });
      let settled = false;
      const pending = api[entry](target, {}).finally(() => { settled = true; });
      try {
        await syncEntered.promise;
        // Drain continuations even if the implementation accidentally stops awaiting sync.
        for (let i = 0; i < 20; i++) await Promise.resolve();
        assert.deepEqual(events, ['write', 'sync']);
        assert.equal(settled, false);
        t.diagnostic('sync blocked: ' + events.join(','));
        syncRelease.resolve();
        await closeEntered.promise;
        for (let i = 0; i < 20; i++) await Promise.resolve();
        assert.deepEqual(events, ['write', 'sync', 'close']);
        assert.equal(settled, false);
        t.diagnostic('close blocked: ' + events.join(','));
        closeRelease.resolve();
        assert.equal(await pending, entry === 'atomicCreateJson' ? true : undefined);
        assert.deepEqual(events, ['write', 'sync', 'close', publication]);
        t.diagnostic('released: ' + events.join(','));
      } finally {
        syncRelease.resolve();
        closeRelease.resolve();
        await pending;
      }
    });
  }
}

