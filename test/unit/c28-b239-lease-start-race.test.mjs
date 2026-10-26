import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const moduleUrl = source => `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`;
const errors = moduleUrl(await readFile(new URL('../../src/core/errors.ts', import.meta.url), 'utf8'));
const source = stripTypeScriptTypes(await readFile(new URL('../../src/mcp/caller-work-lease-registry.ts', import.meta.url), 'utf8'));
// Only the asynchronous API boundary is substituted; the registry is loaded from source.
const { McpCallerWorkLeaseRegistry, setStart } = await import(moduleUrl(source
  .replace('"../core/errors.js"', JSON.stringify(errors))
  .replace(/import\s*\{[^}]*\}\s*from "\.\.\/api.js";/,
    'let startCueLineCallerWorkLease; const recordCueLineCallerJobProgress = () => { throw new Error("unexpected progress"); }; export const setStart = fn => { startCueLineCallerWorkLease = fn; };')));
const proof = { runId: 'run', jobId: 'job', claimId: 'claim', callerId: 'caller', fencingToken: 1 };
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture() {
  const registry = new McpCallerWorkLeaseRegistry();
  registry.rememberClaim(proof);
  const leases = [];
  const gates = [];
  setStart(async claim => {
    const gate = deferred();
    gates.push(gate);
    await gate.promise;
    const lease = {
      ...claim, proof: claim, active: true, signal: new AbortController().signal, stops: 0,
      async stop() { this.stops++; this.active = false; },
    };
    leases.push(lease);
    return lease;
  });
  return { registry, leases, gates };
}

test('overlapping starts share one lease and close stops every created lease', async () => {
  const { registry, leases, gates } = fixture();
  const first = registry.start(proof, {});
  const second = registry.start({ ...proof }, {});
  gates.forEach(gate => gate.resolve());
  const results = await Promise.all([first, second]);
  await registry.close();
  console.log('concurrent outcomes', results.map(result => result.outcome), 'starts', gates.length, 'stops', leases.reduce((n, lease) => n + lease.stops, 0));
  assert.equal(gates.length, 1);
  assert.deepEqual(results.map(result => result.outcome), ['started', 'already_active']);
  assert.ok(leases.every(lease => lease.stops === 1));
});

test('failed shared startup rejects both callers and permits retry', async () => {
  const { registry, gates, leases } = fixture();
  const failure = new Error('startup failed');
  const first = assert.rejects(registry.start(proof, {}), error => error === failure);
  const second = assert.rejects(registry.start(proof, {}), error => error === failure);
  gates.forEach(gate => gate.reject(failure));
  await Promise.all([first, second]);
  const failedStarts = gates.length;
  const retry = registry.start(proof, {});
  gates.at(-1).resolve();
  assert.equal((await retry).outcome, 'started');
  await registry.close();
  assert.equal(failedStarts, 1);
  assert.equal(leases.length, 1);
  assert.equal(leases[0].stops, 1);
});

test('a different proof is rejected during startup, including a replaced retained claim', async () => {
  const { registry, gates } = fixture();
  const first = registry.start(proof, {});
  const different = { ...proof, claimId: 'other', fencingToken: 2 };
  await assert.rejects(registry.start(different, {}), { code: 'MCP_CALLER_WORK_LEASE_PROOF_MISMATCH' });
  registry.rememberClaim(different);
  const other = registry.start(different, {});
  const check = assert.rejects(other, { code: 'MCP_CALLER_WORK_LEASE_PROOF_MISMATCH' });
  gates.forEach(gate => gate.resolve());
  await first;
  await check;
  await registry.close();
});

test('different jobs start independently and close waits for pending creations', async () => {
  const { registry, gates, leases } = fixture();
  const other = { ...proof, jobId: 'other' };
  registry.rememberClaim(other);
  const first = registry.start(proof, {});
  const second = registry.start(other, {});
  assert.equal(gates.length, 2);
  const closing = registry.close();
  gates.forEach(gate => gate.resolve());
  await Promise.all([first, second, closing]);
  assert.equal(leases.length, 2);
  assert.ok(leases.every(lease => lease.stops === 1));
});
