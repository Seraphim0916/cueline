import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import test from 'node:test';

const sourceRoot = new URL('../../src/', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // The synchronous public builder must not perform persisted I/O.
    if (context.parentURL === sourceRoot + 'observation/run-handoff.ts') {
      const unusedLoader = {
        '../api-runtime-lifecycle.js': 'loadCueLineRunStatus',
        '../core/persisted-run.js': 'loadPersistedRunStore',
      }[specifier];
      if (unusedLoader) return nextResolve('data:text/javascript,' + encodeURIComponent(
        `export function ${unusedLoader}() { throw new Error('unexpected persisted I/O'); }`), context);
    }
    if (context.parentURL?.startsWith(sourceRoot)
        && specifier.startsWith('.') && specifier.endsWith('.js')) {
      return nextResolve(specifier.slice(0, -3) + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
});
let buildCueLineRunHandoff, initialRunState, summarizeCueLineRunState;
try {
  ({ buildCueLineRunHandoff } = await import('../../src/observation/run-handoff.ts'));
  ({ initialRunState } = await import('../../src/core/state-machine.ts'));
  ({ summarizeCueLineRunState } = await import('../../src/core/run-status.ts'));
} finally {
  hooks.deregister();
}

function state() {
  return initialRunState('run_unicode', '', 'caller', 12, false);
}
function setField(run, field, value) {
  if (field !== 'task') { run[field] = value; return; }
  run.jobs.job_unicode = {
    jobId: 'job_unicode', jobKey: 'unicode', required: true, status: 'pending',
    spec: { job_key: 'unicode', lane: 'default', mode: 'advise', task: value },
    output: null, error: null,
  };
}
function packet(run, maximum, includeContent = true) {
  return buildCueLineRunHandoff(run,
    summarizeCueLineRunState(run, 0, { ownership: 'missing' }), tmpdir(),
    { includeContent, maxContentChars: maximum });
}
function values(content) {
  return [content.request, ...Object.values(content.tasks),
    content.finalDeliveryText ?? '', content.blockedReason ?? ''];
}

for (const field of ['request', 'task', 'finalDeliveryText', 'blockedReason']) {
  test(`${field}: preserves surrogate pairs before, across and after each budget cut`, () => {
    for (const maximum of [32, 48, 2000, 10000]) {
      const budget = field === 'request' ? maximum : maximum / 2;
      const cut = budget - '[truncated]'.length;
      for (const offset of [-2, -1, 0]) {
        const run = state();
        if (field !== 'request') run.request = 'r'.repeat(budget);
        const prefix = 'a'.repeat(cut + offset);
        setField(run, field, prefix + '😀' + 'z'.repeat(maximum));
        const content = packet(run, maximum).content;
        const actual = field === 'task' ? content.tasks.job_unicode : content[field];
        assert.equal(actual.isWellFormed(), true, `${field}, maximum=${maximum}, offset=${offset}`);
        assert.equal(actual, prefix + (offset === -2 ? '😀' : '') + '[truncated]');
        assert.ok(values(content).reduce((sum, value) => sum + value.length, 0) <= maximum);
      }
    }
  });
}

test('minimum request budget reproduces aaaa plus emoji boundary', () => {
  const run = state();
  run.request = 'aaaa😀' + 'z'.repeat(32);
  assert.equal(packet(run, 16).content.request, 'aaaa[truncated]');
});

test('all fields share one cap, including tiny shares and returned spare code units', () => {
  for (const maximum of [16, 22, 32, 160, 2000, 10000]) {
    const run = state();
    for (const field of ['request', 'task', 'finalDeliveryText', 'blockedReason']) {
      setField(run, field, '😀'.repeat(10001));
    }
    const content = packet(run, maximum).content;
    assert.ok(values(content).every(value => value.isWellFormed()));
    assert.ok(values(content).reduce((sum, value) => sum + value.length, 0) <= maximum);
  }
});

test('fitting Unicode remains intact and default policy still hides content', () => {
  const run = state();
  run.request = 'a'.repeat(14) + '😀';
  assert.equal(packet(run, 16).content.request, run.request);
  assert.equal(buildCueLineRunHandoff(run,
    summarizeCueLineRunState(run, 0, { ownership: 'missing' }), tmpdir()).content, undefined);
});
