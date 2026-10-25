import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const sourceRoot = new URL('../../src/', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot)
        && specifier.startsWith('.') && specifier.endsWith('.js')) {
      return nextResolve(specifier.slice(0, -3) + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
});
let materializeRunnerSpec;
try {
  ({ materializeRunnerSpec } = await import('../../src/router/materialize.ts'));
} finally {
  hooks.deregister();
}

const job = () => ({ job_key: 'precedence', lane: 'test', mode: 'work', task: 'task text' });
const route = () => ({
  lane: 'test', candidateIndex: 0,
  candidate: { id: 'never-spawn', argv: ['never-spawn', '--cwd', '{workdir}', '{task}'] },
});

for (const [label, fields, options, cwd, timeoutMs] of [
  ['job overrides options', { workdir: '/job', timeout_ms: 123 }, { cwd: '/options', timeoutMs: 456 }, '/job', 123],
  ['options override defaults', {}, { cwd: '/options', timeoutMs: 456 }, '/options', 456],
  ['defaults with empty options', {}, {}, process.cwd(), 600_000],
  ['independent job cwd and option timeout', { workdir: '/job' }, { cwd: '/options', timeoutMs: 456 }, '/job', 456],
  ['independent option cwd and job timeout', { timeout_ms: 123 }, { cwd: '/options', timeoutMs: 456 }, '/options', 123],
  ['positive timeout boundary', { timeout_ms: 1 }, { timeoutMs: 456 }, process.cwd(), 1],
  ['undefined fields fall back', { workdir: undefined, timeout_ms: undefined }, { cwd: '/options', timeoutMs: 456 }, '/options', 456],
]) {
  test(label, () => {
    const result = materializeRunnerSpec('job-id', { ...job(), ...fields }, route(), options);
    assert.equal(result.cwd, cwd);
    assert.equal(result.timeoutMs, timeoutMs);
    assert.deepEqual(result.argv, ['never-spawn', '--cwd', cwd, 'task text']);
  });
}

test('omitting the options argument uses existing cwd and ten-minute defaults', () => {
  const result = materializeRunnerSpec('job-id', job(), route());
  assert.equal(result.cwd, process.cwd());
  assert.equal(result.timeoutMs, 600_000);
});

for (const value of [false, true, undefined]) {
  test(`explicit background ${value} preserves presence semantics`, () => {
    const result = materializeRunnerSpec('job-id', { ...job(), background: value }, route());
    assert.equal(Object.hasOwn(result, 'background'), value !== undefined);
    assert.equal(result.background, value);
  });
}

test('omitted background is absent rather than an own undefined property', () => {
  const result = materializeRunnerSpec('job-id', job(), route());
  assert.equal(Object.hasOwn(result, 'background'), false);
});

test('materialization preserves all inputs and allocates its own argv', () => {
  const inputJob = { ...job(), workdir: '/job', timeout_ms: 123, background: false };
  const inputRoute = route();
  const options = { cwd: '/options', timeoutMs: 456 };
  const before = structuredClone({ inputJob, inputRoute, options });
  Object.freeze(inputJob);
  Object.freeze(inputRoute.candidate.argv);
  Object.freeze(inputRoute.candidate);
  Object.freeze(inputRoute);
  Object.freeze(options);
  const result = materializeRunnerSpec('job-id', inputJob, inputRoute, options);
  assert.equal(result.cwd, '/job');
  assert.equal(result.timeoutMs, 123);
  assert.equal(result.background, false);
  assert.equal(Object.hasOwn(result, 'background'), true);
  assert.notEqual(result.argv, inputRoute.candidate.argv);
  result.argv.push('output-only');
  assert.deepEqual({ inputJob, inputRoute, options }, before);
});
