import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { compileFunction } from 'node:vm';

const source = stripTypeScriptTypes(await readFile(
  new URL('../../src/observation/run-bundle.ts', import.meta.url), 'utf8',
)).replace(/^import\b[\s\S]*?;\n/gm, '').replace(/^export /gm, '');

for (const failure of ['status', 'verification', 'timeline']) {
  test(`${failure} failure rejects unchanged without projecting a partial bundle`, async (t) => {
    const calls = [];
    const error = new Error(`${failure} unavailable`);
    const pending = Promise.withResolvers();
    const started = Promise.withResolvers();
    const loader = (name) => async () => {
      calls.push(name);
      if (name === 'timeline') started.resolve();
      if (name === failure) throw error;
      return name === 'status' ? {} : pending.promise;
    };
    const dependencies = {
      loadCueLineRunStatus: loader('status'),
      verifyCueLineRun: loader('verification'),
      loadCueLineRunTimeline: loader('timeline'),
      safeCueLineRunStatus: () => { calls.push('projection'); },
      diagnoseCueLineRunStatus: () => { calls.push('diagnosis'); },
      CUELINE_VERSION: 'fixture',
    };
    const build = compileFunction(`${source}\nreturn buildCueLineRunSupportBundle;`,
      Object.keys(dependencies))(...Object.values(dependencies));
    const result = build('run', { home: 'unused', environment: {} });
    const rejected = assert.rejects(result, (actual) => {
      assert.strictEqual(actual, error);
      return true;
    });
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Bundle failure did not reject within 2000 ms')), 2000);
    });
    try {
      await Promise.race([
        Promise.all([
          // Both reads start while the non-failing sibling is still unresolved.
          failure === 'status' ? Promise.resolve() : started.promise,
          rejected,
        ]),
        deadline,
      ]);
      assert.deepEqual(calls, failure === 'status'
        ? ['status'] : ['status', 'verification', 'timeline']);
      pending.resolve({});
      await Promise.resolve();
      assert.ok(!calls.includes('projection') && !calls.includes('diagnosis'));
      t.diagnostic(`sameError true calls ${calls.join(',')} projection/diagnosis 0`);
    } finally {
      clearTimeout(timer);
      started.resolve();
      pending.resolve({});
    }
  });
}
