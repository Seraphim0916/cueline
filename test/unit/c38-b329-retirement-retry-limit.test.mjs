import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const root = new URL('../../src/', import.meta.url).href;
const entry = new URL('../../src/state/runtime-retirement.ts', import.meta.url).href;
// Share counters across dependency substitutions; any persistence is forbidden.
const stubURL = `data:text/javascript,${encodeURIComponent(`
  export const calls = { markerLists: 0, writes: 0 };
  export async function readdir() { calls.markerLists++; return []; }
  export async function readFile() { throw new Error('unexpected marker read'); }
  export async function atomicWriteJson() { calls.writes++; throw new Error('unexpected write'); }
  export async function ensurePrivateDirectory() { calls.writes++; throw new Error('unexpected mkdir'); }
`)}`;
const { calls } = await import(stubURL);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === entry && ['node:fs/promises', './atomic-write.js', './private-directory.js'].includes(specifier)) {
      return { url: stubURL, shortCircuit: true };
    }
    if (context.parentURL?.startsWith(root) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      return nextResolve(specifier.slice(0, -3) + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
});
let readStableRuntimeOwnerRetirementCutoffs;
try {
  ({ readStableRuntimeOwnerRetirementCutoffs } = await import(entry));
} finally {
  hooks.deregister();
}

for (const stabilizes of [false, true]) {
  test(stabilizes ? 'eighth round may still succeed' : 'changing identities stop after exactly eight rounds', async () => {
    calls.markerLists = 0;
    calls.writes = 0;
    let leaseReads = 0;
    const readLease = async () => {
      leaseReads++;
      assert.ok(leaseReads <= 16, 'must not start a ninth round');
      return {
        identity: String(stabilizes && leaseReads === 16 ? 15 : leaseReads),
        missing: false,
        retirements: [{ owner_id: `owner-${leaseReads}`, events_after_sequence: leaseReads, retired_at: '2026-10-27T00:00:00.000Z' }],
      };
    };
    const result = readStableRuntimeOwnerRetirementCutoffs('/fixture/home', 'retry-limit', readLease);
    if (stabilizes) {
      assert.deepEqual([...(await result)], [['owner-16', 16]], 'use only the stable after-snapshot');
    } else {
      await assert.rejects(result, { message: 'RUNTIME_OWNER_RETIREMENT_EVIDENCE_UNSTABLE' });
    }
    assert.equal(leaseReads, 16);
    assert.equal(calls.markerLists, 8);
    assert.equal(calls.writes, 0);
  });
}
