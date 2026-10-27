import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = new URL('../../src/', import.meta.url).href;
const entry = new URL('../../src/state/runtime-retirement.ts', import.meta.url).href;
// Only the first listing is stale. Later reads use real files and the real parser.
const fsURL = `data:text/javascript,${encodeURIComponent(`
  import * as fs from 'node:fs/promises';
  export const calls = { markerLists: 0, markerReads: 0, order: [] };
  export async function readdir(...args) {
    calls.markerLists++;
    calls.order.push('markers');
    return calls.markerLists === 1 ? [] : fs.readdir(...args);
  }
  export async function readFile(...args) {
    calls.markerReads++;
    return fs.readFile(...args);
  }
`)}`;
const { calls } = await import(fsURL);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === entry && specifier === 'node:fs/promises') {
      return { url: fsURL, shortCircuit: true };
    }
    if (context.parentURL?.startsWith(root) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      return nextResolve(specifier.slice(0, -3) + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
});
let readStableRuntimeOwnerRetirementCutoffs, runPaths;
try {
  ({ readStableRuntimeOwnerRetirementCutoffs } = await import(entry));
  ({ runPaths } = await import('../../src/state/paths.ts'));
} finally {
  hooks.deregister();
}

test('unlink re-reads the final marker batch and excludes stale embedded evidence', async (t) => {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'c38-retirement-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const runId = 'unlink-race';
  const directory = `${runPaths(home, runId).runtimeLease}.retired-owners`;
  await fs.mkdir(directory, { recursive: true });
  const owner = 'fixture-owner';
  const hash = createHash('sha256').update(owner).digest('hex').slice(0, 24);
  const markerName = `${hash}-12345678-1234-4123-8123-123456789abc.json`;
  const marker = JSON.stringify({
    protocol: 'cueline/runtime-owner-retirement/0.1', run_id: runId,
    owner_id: owner, events_after_sequence: 7, retired_at: '2026-10-27T00:00:00.000Z',
  });
  await fs.writeFile(path.join(directory, markerName), marker);
  const stale = { owner_id: 'stale-owner', events_after_sequence: 1, retired_at: '2026-10-26T00:00:00.000Z' };
  const snapshots = [
    { identity: 'leased', missing: false, retirements: [stale] },
    { identity: 'missing', missing: true, retirements: [stale] },
    { identity: 'missing', missing: true, retirements: [stale] },
  ];
  let leaseReads = 0;
  const cutoffs = await readStableRuntimeOwnerRetirementCutoffs(home, runId, async () => {
    calls.order.push('lease');
    assert.ok(leaseReads < snapshots.length, 'no unexpected retry');
    return snapshots[leaseReads++];
  });
  assert.deepEqual([...cutoffs], [['fixture-owner', 7]]);
  assert.equal(cutoffs.has('stale-owner'), false);
  assert.equal(leaseReads, 3);
  assert.equal(calls.markerLists, 2);
  assert.equal(calls.markerReads, 1);
  assert.deepEqual(calls.order, ['lease', 'markers', 'lease', 'markers', 'lease']);
  assert.deepEqual(await fs.readdir(directory), [markerName]);
  assert.equal(await fs.readFile(path.join(directory, markerName), 'utf8'), marker);
});
