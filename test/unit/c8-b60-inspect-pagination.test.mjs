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
let lintControllerCommandText, validateControllerCommand;
try {
  ({ lintControllerCommandText } = await import('../../src/protocol/lint-command.ts'));
  ({ validateControllerCommand } = await import('../../src/protocol/validate-command.ts'));
} finally {
  hooks.deregister();
}

const expected = { runId: 'run_c8', round: 1, requestId: 'request_c8' };
const command = { protocol: 'cueline/0.1', run_id: expected.runId, round: expected.round,
  request_id: expected.requestId, action: 'inspect', job_ids: ['job_1'],
  evidence_offset: 0, evidence_hash: 'a'.repeat(64) };
const lint = (value) => lintControllerCommandText(JSON.stringify(value), { expected });

test('valid pagination passes preflight and matches the formal validator', () => {
  for (const evidence_offset of [0, 10, 1_000_000_000]) {
    const value = { ...command, evidence_offset };
    const validated = validateControllerCommand(value, expected);
    for (const text of [JSON.stringify(value), `<CueLineControl>${JSON.stringify(value)}</CueLineControl>`]) {
      const result = lintControllerCommandText(text, { expected });
      assert.equal(result.valid, true, JSON.stringify(result.issues));
      assert.deepEqual(result.command, validated);
      assert.deepEqual(result.issues, []);
    }
  }
});

test('missing pair, malformed hash, invalid offsets and multiple IDs stay rejected', () => {
  const { evidence_offset, evidence_hash, ...plain } = command;
  const invalid = [
    { ...plain, evidence_offset }, { ...plain, evidence_hash },
    ...['bad', 'A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)].map((hash) => ({ ...command, evidence_hash: hash })),
    ...[-1, 0.5, 1_000_000_001].map((offset) => ({ ...command, evidence_offset: offset })),
    { ...command, job_ids: ['job_1', 'job_2'] }, { ...command, job_ids: [] },
  ];
  for (const value of invalid) {
    assert.throws(() => validateControllerCommand(value, expected));
    assert.equal(lint(value).valid, false);
  }
  assert.equal(lint(plain).valid, true);
});

test('pagination fields remain disallowed on every other action', () => {
  for (const action of ['dispatch', 'wait', 'complete', 'blocked']) {
    const result = lint({ ...command, action });
    assert.equal(result.valid, false);
    for (const field of ['evidence_offset', 'evidence_hash']) {
      assert.ok(result.issues.some((issue) =>
        issue.code === 'CONTROL_FIELD_NOT_ALLOWED_FOR_ACTION' && issue.path === `$.${field}`));
    }
  }
});
