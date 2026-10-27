import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = await readFile(new URL('../../src/browser/claude-desktop/node-file-bridge-fs.ts', import.meta.url), 'utf8');
const { createNodeFileBridgeFs, setFs } = await import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source
  .replace(/import .* from "node:fs\/promises";/, 'let mkdir, readFile, rename, rm, writeFile; export const setFs = (fs) => { ({ mkdir, readFile, rename, rm, writeFile } = fs); };')))}`);
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('same target serializes across instances through rename; other targets proceed', async () => {
  const entered = deferred();
  const release = deferred();
  const staging = new Map();
  const published = [];
  const writes = [];
  setFs({
    writeFile: async (path, contents) => { writes.push([path, contents]); staging.set(path, contents); },
    rename: async (from, to) => {
      if (to === '/a' && published.every(([path]) => path !== '/a')) { entered.resolve(); await release.promise; }
      if (!staging.has(from)) throw Object.assign(new Error('missing staging'), { code: 'ENOENT' });
      published.push([to, staging.get(from)]); staging.delete(from);
    },
  });
  const first = createNodeFileBridgeFs().writeAtomic('/a', 'A');
  await entered.promise;
  const second = createNodeFileBridgeFs().writeAtomic('/a', 'B');
  const both = Promise.allSettled([first, second]);
  await createNodeFileBridgeFs().writeAtomic('/b', 'C');
  await tick();
  const beforeRelease = writes.slice();
  release.resolve();
  const outcomes = await both;
  assert.deepEqual(beforeRelease, [['/a.partial', 'A'], ['/b.partial', 'C']]);
  assert.deepEqual(outcomes.map((r) => r.status), ['fulfilled', 'fulfilled']);
  assert.deepEqual(published, [['/b', 'C'], ['/a', 'A'], ['/a', 'B']]);
});

for (const failingOperation of ['write', 'rename']) {
  test(`${failingOperation} failure does not poison queued or later writes`, async () => {
    const error = new Error(failingOperation);
    const entered = deferred();
    const release = deferred();
    const published = [];
    let writes = 0;
    let renames = 0;
    setFs({
      writeFile: async () => { if (++writes === 1 && failingOperation === 'write') { entered.resolve(); await release.promise; throw error; } },
      rename: async (_from, to) => { if (++renames === 1 && failingOperation === 'rename') { entered.resolve(); await release.promise; throw error; } published.push(to); },
    });
    const fs = createNodeFileBridgeFs();
    const first = fs.writeAtomic('/failure', 'A');
    await entered.promise;
    const second = fs.writeAtomic('/failure', 'B');
    const both = Promise.allSettled([first, second]);
    release.resolve();
    const results = await both;
    assert.equal(results[0].status, 'rejected');
    assert.equal(results[0].reason, error);
    assert.equal(results[1].status, 'fulfilled');
    await fs.writeAtomic('/failure', 'C');
    assert.deepEqual(published, ['/failure', '/failure']);
  });
}
