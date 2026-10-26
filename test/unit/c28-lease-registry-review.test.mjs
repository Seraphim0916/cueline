import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

// Argon review of the R51 follow-up: retried starts, other claims of the same job, leases being stopped, close().
const moduleUrl = source => `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`;
const errors = moduleUrl(await readFile(new URL('../../src/core/errors.ts', import.meta.url), 'utf8'));
const source = stripTypeScriptTypes(await readFile(new URL('../../src/mcp/caller-work-lease-registry.ts', import.meta.url), 'utf8'));
// Only the asynchronous API boundary is substituted; the registry is loaded from source.
const { McpCallerWorkLeaseRegistry, setStart } = await import(moduleUrl(source
  .replace('"../core/errors.js"', JSON.stringify(errors))
  .replace(/import\s*\{[^}]*\}\s*from "\.\.\/api.js";/,
    'let startCueLineCallerWorkLease; const recordCueLineCallerJobProgress = () => { throw new Error("unexpected progress"); }; export const setStart = fn => { startCueLineCallerWorkLease = fn; };')));
const proof = { runId: 'run', jobId: 'job', claimId: 'claim', callerId: 'caller', fencingToken: 1 };
const newer = { ...proof, claimId: 'claim-2', fencingToken: 2 };
const other = { ...proof, jobId: 'other' };
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
// Resolves after every pending microtask and I/O callback: a promise still blocked on a gate has not settled by then.
const settledYet = promise => Promise.race([promise.then(() => true, () => true), new Promise(resolve => setImmediate(() => resolve(false)))]);

// stopGate, when given, makes stop() asynchronous like the real lease (it waits for queued mutations).
function fixture({ stopGate } = {}) {
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
      async stop() { this.stops++; this.active = false; if (stopGate) await stopGate.promise; },
    };
    leases.push(lease);
    return lease;
  });
  return { registry, leases, gates };
}

test('item 1: end() also waits for a start retried after the one it waited for failed', { timeout: 2000 }, async () => {
  const { registry, leases, gates } = fixture();
  let retried;
  const first = registry.start(proof, {}).catch(() => { retried = registry.start(proof, {}); });
  const ending = registry.end(proof);
  gates[0].reject(new Error('transient'));
  await first;
  assert.ok(retried, 'the caller retried at once');
  assert.equal(await settledYet(ending), false, 'end() must wait for the retried start too');
  gates[1].resolve();
  const [started, ended] = await Promise.all([retried, ending]);
  assert.equal(started.outcome, 'started');
  assert.equal(ended.outcome, 'ended');
  assert.equal(leases.length, 1);
  assert.equal(leases[0].stops, 1, 'the lease of the retried start is stopped, not left running');
  assert.equal(registry.status(proof).outcome, 'inactive');
});

test('item 2: ending an older claim does not wait for the start of a newer claim of the same job', { timeout: 2000 }, async () => {
  const { registry, gates } = fixture();
  registry.rememberClaim(newer);
  const starting = registry.start(newer, {});
  const submitted = registry.endAfterSubmission(proof);
  assert.equal(await settledYet(submitted), true, 'the older claim has nothing in flight to wait for');
  await submitted;
  gates[0].resolve();
  assert.equal((await starting).outcome, 'started');
  assert.equal(registry.status(newer).outcome, 'active');
  await registry.close();
});

test('item 3a: a lease started while an older one is still stopping stays registered', { timeout: 2000 }, async () => {
  const stopGate = deferred();
  const { registry, leases, gates } = fixture({ stopGate });
  const first = registry.start(proof, {});
  gates[0].resolve();
  await first;
  const submitted = registry.endAfterSubmission(proof);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 20 && leases[0].stops === 0; i++) await tick();
  assert.equal(leases[0].stops, 1, 'the older lease is stopping');
  // A newer claim of the job starts while the older lease is still stopping.
  registry.rememberClaim(newer);
  const starting = registry.start(newer, {});
  for (let i = 0; i < 20 && gates.length < 2; i++) await tick();
  if (gates[1]) {
    gates[1].resolve();
    await starting;
  }
  stopGate.resolve();
  await submitted;
  for (let i = 0; i < 20 && gates.length < 2; i++) await tick();
  gates[1].resolve();
  await starting;
  assert.equal(leases[0].stops, 1, 'the starting lease does not stop the older one a second time');
  assert.equal(registry.status(newer).outcome, 'active', 'the newer lease must not be dropped by the older stop');
  await registry.close();
  assert.equal(leases[1].stops, 1, 'close() still reaches the newer lease');
});

test('item 3b: end() and close() racing a pending start stop its lease once', { timeout: 2000 }, async () => {
  const { registry, leases, gates } = fixture();
  const starting = registry.start(proof, {});
  const ending = registry.end(proof);
  const closing = registry.close();
  gates[0].resolve();
  await Promise.all([starting, ending, closing]);
  assert.equal(leases[0].stops, 1);
});

test('item 3b: two end() calls for one lease stop it once and the second answers already_ended', { timeout: 2000 }, async () => {
  const stopGate = deferred();
  const { registry, leases, gates } = fixture({ stopGate });
  const starting = registry.start(proof, {});
  gates[0].resolve();
  await starting;
  const one = registry.end(proof);
  const two = registry.end(proof);
  stopGate.resolve();
  const outcomes = (await Promise.all([one, two])).map(view => view.outcome).sort();
  assert.deepEqual(outcomes, ['already_ended', 'ended']);
  assert.equal(leases[0].stops, 1);
});

test('item 3b: close() waits for a stop that end() already began', { timeout: 2000 }, async () => {
  const stopGate = deferred();
  const { registry, gates } = fixture({ stopGate });
  const starting = registry.start(proof, {});
  gates[0].resolve();
  await starting;
  const ending = registry.end(proof);
  const closing = registry.close();
  assert.equal(await settledYet(closing), false, 'close() must not finish while a lease is still stopping');
  stopGate.resolve();
  await Promise.all([ending, closing]);
});

test('item 4: start() after close() has finished is refused as closed, even for a claim the session never saw', { timeout: 2000 }, async () => {
  const { registry } = fixture();
  await registry.close();
  await assert.rejects(registry.start(proof, {}), { code: 'MCP_CALLER_WORK_LEASE_REGISTRY_CLOSED' });
  const unknown = { ...proof, jobId: 'never-claimed' };
  await assert.rejects(registry.start(unknown, {}), { code: 'MCP_CALLER_WORK_LEASE_REGISTRY_CLOSED' });
});

test('item 4: close() while one start fails and another lease is alive neither hangs nor leaves the live lease', { timeout: 2000 }, async () => {
  const { registry, leases, gates } = fixture();
  const alive = registry.start(other, {});
  gates[0].resolve();
  await alive;
  const failing = assert.rejects(registry.start(proof, {}), /startup failed/);
  const closing = registry.close();
  gates[1].reject(new Error('startup failed'));
  await failing;
  assert.equal(await settledYet(closing), true, 'close() must not hang on the failed start');
  await closing;
  assert.equal(leases.length, 1);
  assert.equal(leases[0].stops, 1);
  assert.equal(leases[0].active, false);
});
