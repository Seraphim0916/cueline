import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as vm from 'node:vm';

if (!vm.SourceTextModule) {
  test('takeover failure with VM modules enabled', () => {
    const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--test', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 30_000 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  });
} else {
  async function harness(failure) {
    const calls = [];
    const home = join(tmpdir(), 'c34-b294-synthetic');
    const directory = `${join(home, 'lease.json')}.takeover-intents`;
    const sentinel = new Error(`synthetic ${failure ?? 'success'} boundary`);
    const dependencies = {
      'node:crypto': { randomUUID },
      './paths.js': { runPaths: () => ({ runtimeLease: join(home, 'lease.json') }) },
      './private-directory.js': { ensurePrivateDirectory: async (path) => {
        calls.push('ensure');
        assert.equal(path, directory);
        // Yield before completing to detect a missing await at this boundary.
        await Promise.resolve();
        if (failure === 'ensure') throw sentinel;
        calls.push('ensure-complete');
      } },
      './atomic-write.js': { atomicWriteJson: async (path) => {
        calls.push('write');
        assert.ok(path.startsWith(`${directory}/`));
        await Promise.resolve();
        if (failure === 'write') throw sentinel;
        calls.push('write-complete');
      } },
    };
    const subject = new vm.SourceTextModule(stripTypeScriptTypes(await readFile(new URL('../../src/state/runtime-takeover-intent.ts', import.meta.url), 'utf8')));
    await subject.link((specifier) => {
      const exports = dependencies[specifier];
      assert.ok(exports, `unexpected dependency: ${specifier}`);
      return new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      });
    });
    await subject.evaluate();
    return { calls, sentinel, persist: () => subject.namespace.persistRuntimeTakeoverIntent(
      home, 'run-synthetic', 'owner-synthetic', '2026-10-27T00:00:00Z', '2026-10-27T00:00:01Z'),
    };
  }

  test('directory failure preserves the error and never writes', async () => {
    const { calls, sentinel, persist } = await harness('ensure');
    await assert.rejects(persist(), (error) => error === sentinel);
    assert.deepEqual(calls, ['ensure']);
    console.log('ensure same error true calls ensure');
  });

  test('write failure preserves the error without retry or success record', async () => {
    const { calls, sentinel, persist } = await harness('write');
    await assert.rejects(persist(), (error) => error === sentinel);
    assert.deepEqual(calls, ['ensure', 'ensure-complete', 'write']);
    console.log('write same error true calls ensure,write');
  });

  test('success awaits directory preparation and then the single write', async () => {
    const { calls, persist } = await harness();
    assert.equal(await persist(), undefined);
    assert.deepEqual(calls, ['ensure', 'ensure-complete', 'write', 'write-complete']);
  });
}
