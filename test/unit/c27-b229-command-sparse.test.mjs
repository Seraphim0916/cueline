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
let validateControllerCommand;
try {
  ({ validateControllerCommand } = await import('../../src/protocol/validate-command.ts'));
} finally {
  hooks.deregister();
}

const expected = { runId: 'run_b229', round: 1, requestId: 'request_b229' };
const base = { protocol: 'cueline/0.1', run_id: expected.runId,
  round: expected.round, request_id: expected.requestId };
const job = key => ({ job_key: key, lane: 'lane', mode: 'advise', task: 'fixture' });
const invalid = { name: 'CueLineError', code: 'CONTROL_COMMAND_INVALID' };

// 首、中、尾三種位置的空洞，加上只有長度沒有元素的 Array(n)。
const withHole = (items, index) => {
  const copy = [...items];
  delete copy[index];
  return copy;
};

for (const index of [0, 1, 2]) {
  test(`dispatch jobs with a hole at index ${index} is a controlled validation error`, () => {
    const jobs = withHole(['a', 'b', 'c'].map(job), index);
    assert.throws(() => validateControllerCommand({ ...base, action: 'dispatch', jobs }, expected), invalid);
  });

  for (const action of ['wait', 'inspect']) {
    test(`${action} job_ids with a hole at index ${index} is a controlled validation error`, () => {
      const job_ids = withHole(['job_a', 'job_b', 'job_c'], index);
      assert.throws(() => validateControllerCommand({ ...base, action, job_ids }, expected), invalid);
    });
  }
}

test('Array(n) with no elements is rejected for jobs and job_ids', () => {
  assert.throws(() => validateControllerCommand({ ...base, action: 'dispatch', jobs: Array(1) }, expected), invalid);
  assert.throws(() => validateControllerCommand({ ...base, action: 'dispatch', jobs: Array(3) }, expected), invalid);
  for (const action of ['wait', 'inspect']) {
    assert.throws(() => validateControllerCommand({ ...base, action, job_ids: Array(1) }, expected), invalid);
  }
});

test('explicit undefined elements are still rejected the same way', () => {
  assert.throws(() => validateControllerCommand({ ...base, action: 'dispatch', jobs: [job('a'), undefined] }, expected),
    invalid);
  assert.throws(() => validateControllerCommand({ ...base, action: 'wait', job_ids: ['job_a', undefined] }, expected),
    invalid);
});

test('dense arrays keep their contents and order', () => {
  const dispatch = validateControllerCommand({ ...base, action: 'dispatch', jobs: ['a', 'b', 'c'].map(job) }, expected);
  assert.deepEqual(dispatch.jobs.map(j => j.job_key), ['a', 'b', 'c']);
  for (const action of ['wait', 'inspect']) {
    const command = validateControllerCommand({ ...base, action, job_ids: ['job_a', 'job_b'] }, expected);
    assert.deepEqual(command.job_ids, ['job_a', 'job_b']);
    assert.equal(JSON.stringify(command.job_ids), '["job_a","job_b"]');
  }
});
