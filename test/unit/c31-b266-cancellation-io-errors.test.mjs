import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// C2-B266: only a missing file or directory means "no request"; any other read error reaches the caller, and a
// job file that fails after the directory was listed fails the whole read instead of returning part of it.
// The compiled build is loaded (see c31-b265 for why) with its node:fs/promises import swapped for a shim whose
// readFile/readdir a test can replace; every other module keeps the real file system.
async function fromDist(relative) {
  const built = new URL(`../../dist/src/${relative}.js`, import.meta.url);
  const source = new URL(`../../src/${relative}.ts`, import.meta.url);
  const [builtStat, sourceStat] = await Promise.all([fs.stat(built), fs.stat(source)]);
  assert.ok(builtStat.mtimeMs >= sourceStat.mtimeMs, `dist/src/${relative}.js is older than its source; run npm run build`);
  return import(built.href);
}

const overrides = {};
globalThis.c31B266Fs = overrides;
const shim = 'data:text/javascript,' + encodeURIComponent(
  'import * as real from "node:fs/promises";'
  + 'export const readFile = (...args) => (globalThis.c31B266Fs.readFile ?? real.readFile)(...args);'
  + 'export const readdir = (...args) => (globalThis.c31B266Fs.readdir ?? real.readdir)(...args);');
const cancellationUrl = new URL('../../dist/src/state/cancellation.js', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === cancellationUrl && specifier === 'node:fs/promises') {
      return { url: shim, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
let subject;
try {
  subject = await fromDist('state/cancellation');
} finally {
  hooks.deregister();
}
const { runPaths } = await fromDist('state/paths');
const runId = 'run_io';

function failure(code) {
  return Object.assign(new Error(`${code}: injected`), { code });
}

async function home(t) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'c31-io-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  t.after(() => { delete overrides.readFile; delete overrides.readdir; });
  return directory;
}

test('a missing run file or job directory means no request', async (t) => {
  const directory = await home(t);
  assert.equal(await subject.readRunCancellation(directory, runId), undefined);
  assert.deepEqual(await subject.readJobCancellations(directory, runId), []);
});

test('ENOENT from the reader itself is classified the same way', async (t) => {
  const directory = await home(t);
  overrides.readFile = async () => { throw failure('ENOENT'); };
  overrides.readdir = async () => { throw failure('ENOENT'); };
  assert.equal(await subject.readRunCancellation(directory, runId), undefined);
  assert.deepEqual(await subject.readJobCancellations(directory, runId), []);
});

for (const code of ['EACCES', 'EIO']) {
  test(`${code} reading the run file is passed through unchanged`, async (t) => {
    const directory = await home(t);
    const error = failure(code);
    overrides.readFile = async () => { throw error; };
    await assert.rejects(subject.readRunCancellation(directory, runId), (thrown) => thrown === error);
  });

  test(`${code} listing the job directory is passed through unchanged`, async (t) => {
    const directory = await home(t);
    const error = failure(code);
    overrides.readdir = async () => { throw error; };
    await assert.rejects(subject.readJobCancellations(directory, runId), (thrown) => thrown === error);
  });
}

for (const code of ['EIO', 'ENOENT']) {
  test(`${code} on a job file after the listing fails the read, with no partial result`, async (t) => {
    const directory = await home(t);
    await subject.requestJobCancellation(directory, runId, 'job_a', 'stop');
    await subject.requestJobCancellation(directory, runId, 'job_b', 'stop');
    const listed = await fs.readdir(runPaths(directory, runId).jobCancellationsDir);
    assert.deepEqual(listed.filter((name) => name.endsWith('.json')).sort(), ['job_a.json', 'job_b.json']);
    const error = failure(code);
    overrides.readFile = async (file, ...rest) => {
      if (path.basename(String(file)) === 'job_b.json') throw error;
      return fs.readFile(file, ...rest);
    };
    await assert.rejects(subject.readJobCancellations(directory, runId), (thrown) => thrown === error);
  });
}
