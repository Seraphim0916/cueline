import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import test from 'node:test';
import { parseJobStatus } from '../../dist/src/jobs/status.js';

const marker = 'SYNTHETIC_PRIVATE_OUTPUT_C42_B366';
const jobId = 'job_c42_b366';
const valid = {
  jobId, execution: 'foreground', status: 'succeeded',
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:01.000Z',
  result: {
    status: 'succeeded', exitCode: 0,
    stdout: marker, stderr: '', output: marker, emptyOutput: false,
    timedOut: false, cancelled: false, ambiguousSideEffects: false, retryable: false,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
  },
};

for (const [name, source] of [
  ['malformed JSON', `{"stdout":"${marker}",`],
  ['invalid structure', JSON.stringify({ ...valid, execution: marker })],
  ['invalid nested result', JSON.stringify({ ...valid, result: { ...valid.result, exitCode: marker } })],
]) {
  for (const expectedId of [undefined, jobId]) {
    test(`${name}: redacts error surfaces with expected id ${expectedId ?? 'absent'}`, () => {
      assert.throws(() => parseJobStatus(source, expectedId), error => {
        assert.equal(error.code, 'JOB_STATUS_INVALID');
        assert.equal(error.name, 'CueLineError');
        assert.deepEqual(error.details, expectedId === undefined ? undefined : { jobId });
        if (expectedId !== undefined) assert.ok(error.message.includes(jobId));
        assert.equal(Object.hasOwn(error, 'cause'), false);
        for (const field of ['message', 'details', 'cause', 'stack']) {
          assert.equal(inspect(error[field], { depth: null }).includes(marker), false, field);
        }
        assert.equal(inspect(error, { depth: null, showHidden: true }).includes(marker), false);
        return true;
      });
    });
  }
}

test('valid job status retains its job identifier and legitimate output', () => {
  for (const expectedId of [undefined, jobId]) {
    const parsed = parseJobStatus(JSON.stringify(valid), expectedId);
    assert.deepEqual(parsed, valid);
    assert.equal(parsed.jobId, jobId);
    assert.equal(parsed.result.output, marker);
  }
});
