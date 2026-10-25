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

const expected = { runId: 'run_b94', round: 1, requestId: 'request_b94' };
const base = { protocol: 'cueline/0.1', run_id: expected.runId,
  round: expected.round, request_id: expected.requestId };
const dispatch = (field, value) => ({ ...base, action: 'dispatch', jobs: [
  { job_key: 'job', lane: 'lane', mode: 'advise', task: 'fixture', [field]: value },
] });
const invalid = { code: 'CONTROL_COMMAND_INVALID' };

for (const field of ['job_key', 'lane']) {
  test(`${field}: 64 characters pass and 65 are rejected`, () => {
    const value = 'A'.repeat(64);
    assert.equal(validateControllerCommand(dispatch(field, value), expected).jobs[0][field], value);
    assert.throws(() => validateControllerCommand(dispatch(field, value + 'A'), expected), invalid);
  });

  test(`${field}: alphanumeric starts and all allowed continuation characters survive`, () => {
    for (const value of ['A', 'z', '0', '9AZaz09._-']) {
      assert.equal(validateControllerCommand(dispatch(field, value), expected).jobs[0][field], value);
    }
    for (const value of ['', '.key', '_key', '-key', ' key', 'ékey', 'a/b', 'a b']) {
      assert.throws(() => validateControllerCommand(dispatch(field, value), expected), invalid);
    }
  });

  for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    test(`${field}: trailing ${JSON.stringify(suffix)} is rejected`, () => {
      assert.throws(() => validateControllerCommand(dispatch(field, 'key' + suffix), expected), invalid);
    });
  }
}

for (const action of ['wait', 'inspect']) {
  test(`${action} job_ids: own alphabet and no 64-character cap`, () => {
    for (const value of ['A', 'z', '0', '9AZaz09_-', 'a'.repeat(64), 'a'.repeat(65), 'a'.repeat(256)]) {
      const command = { ...base, action, job_ids: [value] };
      assert.deepEqual(validateControllerCommand(command, expected).job_ids, [value]);
    }
    for (const value of ['', '.job', '_job', '-job', 'a.b', 'a/b', 'a b', 'éjob',
      ...['\n', '\r', '\r\n', '\u2028', '\u2029'].map((suffix) => 'job' + suffix)]) {
      assert.throws(() => validateControllerCommand({ ...base, action, job_ids: [value] }, expected), invalid);
    }
  });
}
