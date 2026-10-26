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
let parseJobStatus;
try {
  ({ parseJobStatus } = await import('../../src/jobs/status.ts'));
} finally {
  hooks.deregister();
}

function source(output, emptyOutput) {
  const startedAt = '2026-01-01T00:00:00.000Z';
  const finishedAt = '2026-01-01T00:00:01.000Z';
  return JSON.stringify({
    jobId: 'empty-output', execution: 'foreground', status: 'succeeded',
    startedAt, finishedAt,
    result: {
      status: 'succeeded', exitCode: 0, stdout: output, stderr: '', output,
      emptyOutput, timedOut: false, cancelled: false, ambiguousSideEffects: false,
      retryable: false, startedAt, finishedAt,
    },
  });
}

for (const output of ['', ' ', '\n', 'ordinary text']) {
  test(`raw output ${JSON.stringify(output)} requires its matching boolean flag`, () => {
    const expected = output.length === 0;
    const parsed = parseJobStatus(source(output, expected), 'empty-output');
    assert.equal(parsed.result.output, output);
    assert.equal(typeof parsed.result.emptyOutput, 'boolean');
    assert.equal(parsed.result.emptyOutput, expected);
    assert.throws(() => parseJobStatus(source(output, !expected)), { code: 'JOB_STATUS_INVALID' });
    for (const invalid of [undefined, null, 0, 1, 'true', 'false', [], {}]) {
      assert.throws(() => parseJobStatus(source(output, invalid)), { code: 'JOB_STATUS_INVALID' });
    }
  });
}
