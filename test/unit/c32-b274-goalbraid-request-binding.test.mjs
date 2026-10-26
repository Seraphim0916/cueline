import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Replace only storage boundaries; execute the unchanged public source functions.
const storageUrl = 'data:text/javascript,' + encodeURIComponent(`
  export const files = new Map();
  export async function readFile(file, encoding) {
    if (encoding !== 'utf8' || !files.has(file)) throw new Error('unexpected read: ' + file);
    return files.get(file);
  }
  export async function atomicCreateJson(file, value) {
    if (files.has(file)) return false;
    files.set(file, JSON.stringify(value));
    return true;
  }
`);
const { files } = await import(storageUrl);
const sourceRoot = new URL('../../src/', import.meta.url).href;
const goalbraidUrl = new URL('../../src/integrations/goalbraid.ts', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === goalbraidUrl &&
        (specifier === 'node:fs/promises' || specifier === '../state/atomic-write.js')) {
      return { url: storageUrl, shortCircuit: true };
    }
    if (context.parentURL?.startsWith(sourceRoot) &&
        specifier.startsWith('.') && specifier.endsWith('.js')) {
      return nextResolve(specifier.slice(0, -3) + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
});
let api;
try {
  api = await import(goalbraidUrl);
} finally {
  hooks.deregister();
}

function fixtureRequest() {
  return {
    schema: 'goalbraid-cueline-decision-request/v1',
    request_id: 'gbd-a5d7e51a050e63fdb3e6cf3dee07071c',
    request_digest: 'sha256:a5d7e51a050e63fdb3e6cf3dee07071c4a6c9044d566006d483ec6c61956a38e',
    campaign_id: 'fixture-專案',
    created_at: '2026-07-22T00:00:00+00:00',
    authority: {
      decision_controller: 'cueline', executor: 'omnilane',
      completion_authority: 'goalbraid', advisory_only: true,
    },
    snapshot: {
      schema: 'goalbraid-turning-point/v1',
      runnable_children: [
        { goal_id: '目標-a', run_id: 'run-a', priority: 2, depends_on: [] },
        { goal_id: 'goal-b', run_id: 'run-b', priority: 1, depends_on: [] },
      ],
      rollup_satisfied: false,
      gate: { value_gate_enabled: true, serial_single_holder: true },
    },
    response_schema: 'goalbraid-cueline-decision-response/v1',
  };
}

const requestPath = path.join(tmpdir(), 'c32-b274', 'requests', fixtureRequest().request_id + '.json');

test('public loader accepts the known digest and recursively reordered object keys', async () => {
  const request = fixtureRequest();
  files.set(requestPath, JSON.stringify(request));
  assert.deepEqual(await api.loadGoalbraidDecisionRequest(requestPath), request);
  const reverseKeys = value => Array.isArray(value) ? value.map(reverseKeys)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)]))
      : value;
  const reordered = JSON.stringify(reverseKeys(request));
  assert.notEqual(reordered, JSON.stringify(request));
  files.set(requestPath, reordered);
  assert.deepEqual(await api.loadGoalbraidDecisionRequest(requestPath), request);
});

for (const [name, mutate, code] of [
  ['campaign', request => { request.campaign_id = 'other-campaign'; }, 'GOALBRAID_DECISION_REQUEST_DIGEST_MISMATCH'],
  ['snapshot', request => { request.snapshot.rollup_satisfied = true; }, 'GOALBRAID_DECISION_REQUEST_DIGEST_MISMATCH'],
  ['identifier', request => { request.request_id = 'gbd-other'; }, 'GOALBRAID_DECISION_REQUEST_ID_MISMATCH'],
]) {
  test(name + ' tampering has the exact error code', async () => {
    const request = fixtureRequest();
    mutate(request);
    files.set(requestPath, JSON.stringify(request));
    await assert.rejects(api.loadGoalbraidDecisionRequest(requestPath), { code });
    console.log(name, code);
  });
}

for (const [name, invalidPath] of [
  ['directory', path.join(tmpdir(), 'c32-b274', 'responses', fixtureRequest().request_id + '.json')],
  ['filename', path.join(tmpdir(), 'c32-b274', 'requests', 'wrong.json')],
  ['relative', path.join('requests', fixtureRequest().request_id + '.json')],
]) {
  test(name + ' cannot bypass path binding even with readable valid contents', async () => {
    files.set(invalidPath, JSON.stringify(fixtureRequest()));
    await assert.rejects(api.loadGoalbraidDecisionRequest(invalidPath),
      { code: 'GOALBRAID_DECISION_PATH_INVALID' });
    console.log(name, 'GOALBRAID_DECISION_PATH_INVALID');
  });
}
