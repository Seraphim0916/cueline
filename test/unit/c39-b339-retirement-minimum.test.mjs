import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const cache = new Map();
async function moduleUrl(url) {
  if (cache.has(url.href)) return cache.get(url.href);
  let source = stripTypeScriptTypes(await readFile(url, 'utf8'));
  for (const match of [...source.matchAll(/from "(\.[^"]+\.js)"/g)]) {
    const dependency = await moduleUrl(new URL(match[1].replace(/\.js$/, '.ts'), url));
    source = source.replaceAll(`"${match[1]}"`, JSON.stringify(dependency));
  }
  const result = `data:text/javascript,${encodeURIComponent(source)}`;
  cache.set(url.href, result);
  return result;
}
const { persistRuntimeOwnerRetirements, readStableRuntimeOwnerRetirementCutoffs } =
  await import(await moduleUrl(new URL('../../src/state/runtime-retirement.ts', import.meta.url)));
const { runPaths } = await import(await moduleUrl(new URL('../../src/state/paths.ts', import.meta.url)));
const record = (owner_id, events_after_sequence) => Object.freeze({
  owner_id, events_after_sequence, retired_at: '2026-07-15T00:00:00.000Z',
});

for (const [markerCutoff, leaseCutoff, expected] of [
  [12, 3, 3], [3, 12, 3], [0, 12, 0], [12, 0, 0], [7, 7, 7],
]) {
  test(`marker ${markerCutoff} / lease ${leaseCutoff} retains ${expected} without mutation`, async t => {
    const home = await mkdtemp(path.join(tmpdir(), 'c39-b339-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const runId = 'run_minimum';
    const markers = Object.freeze([record('shared-owner', markerCutoff), record('other-owner', 8)]);
    const snapshot = Object.freeze({
      identity: 'stable-lease', missing: false,
      retirements: Object.freeze([record('shared-owner', leaseCutoff), record('other-owner', 10)]),
    });
    const original = structuredClone({ markers, snapshot });
    await persistRuntimeOwnerRetirements(home, runId, markers);
    const directory = `${runPaths(home, runId).runtimeLease}.retired-owners`;
    const names = (await readdir(directory)).sort();
    assert.equal(names.length, 2);
    const bytesBefore = await Promise.all(names.map(name => readFile(path.join(directory, name), 'utf8')));
    let leaseReads = 0;
    const result = await readStableRuntimeOwnerRetirementCutoffs(home, runId, async () => {
      leaseReads += 1;
      return snapshot;
    });
    assert.equal(leaseReads, 2, 'stable identity requires exactly the before/after snapshots');
    assert.deepEqual([...result].sort(), [['other-owner', 8], ['shared-owner', expected]]);
    assert.deepEqual({ markers, snapshot }, original);
    assert.deepEqual((await readdir(directory)).sort(), names);
    assert.deepEqual(await Promise.all(names.map(name => readFile(path.join(directory, name), 'utf8'))), bytesBefore);
  });
}
