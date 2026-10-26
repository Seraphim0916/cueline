import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

// R51 follow-up: end(), endAfterSubmission() and close() interleaved with a lease start that has not finished.
const moduleUrl = source => `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`;
const errors = moduleUrl(await readFile(new URL('../../src/core/errors.ts', import.meta.url), 'utf8'));
const source = stripTypeScriptTypes(await readFile(new URL('../../src/mcp/caller-work-lease-registry.ts', import.meta.url), 'utf8'));
// Only the asynchronous API boundary is substituted; the registry is loaded from source.
const { McpCallerWorkLeaseRegistry, setStart } = await import(moduleUrl(source
  .replace('"../core/errors.js"', JSON.stringify(errors))
  .replace(/import\s*\{[^}]*\}\s*from "\.\.\/api.js";/,
    'let startCueLineCallerWorkLease; const recordCueLineCallerJobProgress = () => { throw new Error("unexpected progress"); }; export const setStart = fn => { startCueLineCallerWorkLease = fn; };')));
const proof = { runId: 'run', jobId: 'job', claimId: 'claim', callerId: 'caller', fencingToken: 1 };
const other = { ...proof, jobId: 'other' };
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
// Resolves after every pending microtask and I/O callback: a promise still blocked on a gate has not settled by then.
const settledYet = promise => Promise.race([promise.then(() => true, () => true), new Promise(resolve => setImmediate(() => resolve(false)))]);

function fixture() {
  const registry = new McpCallerWorkLeaseRegistry();
  registry.rememberClaim(proof);
  registry.rememberClaim(other);
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

test('end() during a pending start waits for it and ends the lease it creates', async () => {
  const { registry, leases, gates } = fixture();
  const starting = registry.start(proof, {});
  const ending = registry.end(proof);
  assert.equal(await settledYet(ending), false, 'end() must not answer before the start it races has finished');
  gates[0].resolve();
  const [started, ended] = await Promise.all([starting, ending]);
  assert.equal(started.outcome, 'started');
  assert.equal(ended.outcome, 'ended');
  assert.equal(ended.active, false);
  assert.equal(leases.length, 1);
  assert.equal(leases[0].stops, 1);
  assert.equal(leases[0].active, false);
  assert.equal(registry.status(proof).outcome, 'inactive');
  await registry.close();
  assert.equal(leases[0].stops, 1, 'the ended lease is no longer registered, so close() does not stop it again');
});

test('end() during a start that fails answers already_ended and leaves nothing behind', async () => {
  const { registry, leases, gates } = fixture();
  const failure = new Error('startup failed');
  const starting = assert.rejects(registry.start(proof, {}), error => error === failure);
  const ending = registry.end(proof);
  gates[0].reject(failure);
  await starting;
  assert.equal((await ending).outcome, 'already_ended');
  assert.equal(leases.length, 0);
  assert.equal(registry.status(proof).outcome, 'inactive');
});

test('endAfterSubmission() during a pending start stops the lease it creates', async () => {
  const { registry, leases, gates } = fixture();
  const starting = registry.start(proof, {});
  const ending = registry.endAfterSubmission(proof);
  assert.equal(await settledYet(ending), false);
  gates[0].resolve();
  await Promise.all([starting, ending]);
  assert.equal(leases[0].stops, 1);
  assert.equal(registry.status(proof).outcome, 'inactive');
});

test('close() refuses new starts and stops the start already in progress', async () => {
  const { registry, leases, gates } = fixture();
  const inProgress = registry.start(proof, {});
  const closing = registry.close();
  const late = [registry.start(other, {}), registry.start(proof, {})];
  // Checked before awaiting: a start that was let through would wait on its gate and never settle.
  assert.equal(gates.length, 1, 'no lease creation began after close()');
  for (const start of late) await assert.rejects(start, { code: 'MCP_CALLER_WORK_LEASE_REGISTRY_CLOSED' });
  gates[0].resolve();
  await Promise.all([inProgress, closing]);
  assert.equal(leases.length, 1);
  assert.equal(leases[0].stops, 1);
  assert.equal(leases[0].active, false);
});

test('end() for one job does not wait for another job that is still starting', async () => {
  const { registry, gates } = fixture();
  const settled = registry.start(other, {});
  gates[0].resolve();
  await settled;
  const blocked = registry.start(proof, {});
  const ending = registry.end(other);
  assert.equal(await settledYet(ending), true, 'end(other) must not wait for the start of job');
  assert.equal((await ending).outcome, 'ended');
  const submitted = registry.endAfterSubmission(other);
  assert.equal(await settledYet(submitted), true);
  gates[1].resolve();
  await blocked;
  await registry.close();
});
