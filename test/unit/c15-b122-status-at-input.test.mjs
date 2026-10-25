import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as vm from 'node:vm';

// The repository's unit command does not enable VM modules; run the same tests
// in one child with that flag rather than skipping the storage-boundary checks.
if (vm.SourceTextModule === undefined) {
  test('status-at input checks with VM modules enabled', () => {
    const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--test', fileURLToPath(import.meta.url)], {
      encoding: 'utf8', timeout: 30_000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  });
} else {
  const context = vm.createContext({});
  const loadSource = async (path) => new vm.SourceTextModule(
    stripTypeScriptTypes(await readFile(new URL(path, import.meta.url), 'utf8')),
    { context, identifier: path },
  );
  const errors = await loadSource('../../src/core/errors.ts');
  let calls = [];
  const sentinel = new Error('storage boundary reached');
  const trap = (name) => (...args) => { calls.push(name); throw sentinel; };
  const stubs = {
    '../core/persisted-run.js': ['loadPersistedRunStore'],
    '../core/state-machine.js': ['initialRunState', 'reduceRunState'],
    '../state/event-log.js': ['readEvents'],
    '../state/paths.js': ['defaultCueLineHome', 'runPaths'],
    '../state/store.js': ['readAuthoritativeRunEvents'],
  };
  const subject = await loadSource('../../src/observation/run-status-at.ts');
  await subject.link((specifier) => {
    if (specifier === '../core/errors.js') return errors;
    const names = stubs[specifier];
    assert.ok(names, `unexpected dependency: ${specifier}`);
    return new vm.SyntheticModule(names, function () {
      for (const name of names) this.setExport(name, trap(name));
    }, { context });
  });
  await subject.evaluate();
  const { loadCueLineRunStatusAt } = subject.namespace;

  test('eight invalid sequences reject before any storage or path access', async () => {
    calls = [];
    const cases = [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '1'];
    for (const sequence of cases) {
      await assert.rejects(loadCueLineRunStatusAt('run_fixture', {
        sequence, environment: {}, home: 'unused-fixture-home',
      }), { code: 'RUN_STATUS_AT_SEQUENCE_INVALID' }, `sequence ${String(sequence)}`);
      assert.deepEqual(calls, [], `sequence ${String(sequence)} must reject before I/O`);
    }
    console.log('8 cases RUN_STATUS_AT_SEQUENCE_INVALID; IO 0');
  });

  test('a valid sequence reaches the instrumented storage boundary', async () => {
    calls = [];
    await assert.rejects(loadCueLineRunStatusAt('run_fixture', {
      sequence: 1, environment: {}, home: 'unused-fixture-home',
    }), (error) => error === sentinel);
    assert.deepEqual(calls, ['loadPersistedRunStore']);
  });
}
