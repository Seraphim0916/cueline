import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataUrl = source => `data:text/javascript,${encodeURIComponent(source)}`;
const effectsUrl = dataUrl(`
  export const writes = [], directories = [];
  export async function atomicWriteJson(file, value) { writes.push({ file, value }); }
  export async function ensurePrivateDirectory(file) { directories.push(file); }
`);
const { writes, directories } = await import(effectsUrl);
const cache = new Map();
async function moduleUrl(url) {
  if (cache.has(url.href)) return cache.get(url.href);
  let source = stripTypeScriptTypes(await readFile(url, 'utf8'));
  for (const match of [...source.matchAll(/from "(\.[^"]+\.js)"/g)]) {
    const dependency = /\/(atomic-write|private-directory)\.js$/.test(match[1])
      ? effectsUrl : await moduleUrl(new URL(match[1].replace(/\.js$/, '.ts'), url));
    source = source.replaceAll(`"${match[1]}"`, JSON.stringify(dependency));
  }
  const result = dataUrl(source);
  cache.set(url.href, result);
  return result;
}
const { persistRuntimeOwnerRetirements } = await import(await moduleUrl(
  new URL('../../src/state/runtime-retirement.ts', import.meta.url),
));
const record = owner_id => ({
  owner_id, events_after_sequence: 3, retired_at: '2026-07-15T00:00:00.000Z',
});

for (const hole of [0, 1, 2]) {
  test(`batch hole at ${hole} rejects before directory creation or writes`, async () => {
    writes.length = directories.length = 0;
    const batch = ['first', 'middle', 'last'].map(record);
    delete batch[hole];
    let error;
    try {
      await persistRuntimeOwnerRetirements(tmpdir(), 'run_sparse', batch);
    } catch (caught) { error = caught; }
    assert.deepEqual({ code: error?.code, writes: writes.length, directories: directories.length }, {
      code: 'RUNTIME_OWNER_RETIREMENT_INVALID', writes: 0, directories: 0,
    });
  });
}

test('dense valid batch preserves every record and its order', async () => {
  writes.length = directories.length = 0;
  const batch = ['first', 'middle', 'last'].map(record);
  const original = structuredClone(batch);
  await persistRuntimeOwnerRetirements(tmpdir(), 'run_dense', batch);
  assert.equal(directories.length, 3);
  assert.deepEqual(writes.map(({ value }) => value), batch.map(value => ({
    protocol: 'cueline/runtime-owner-retirement/0.1', run_id: 'run_dense', ...value,
  })));
  assert.ok(writes.every(({ file }) => path.isAbsolute(file) && file.endsWith('.json')));
  assert.deepEqual(batch, original);
});
