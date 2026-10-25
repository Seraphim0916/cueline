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
let parseControllerCommand, MAX_CONTROLLER_ENVELOPE_CHARS;
try {
  ({ parseControllerCommand } = await import('../../src/protocol/parse-command.ts'));
  ({ MAX_CONTROLLER_ENVELOPE_CHARS } = await import('../../src/protocol/limits.ts'));
} finally {
  hooks.deregister();
}

const expected = { runId: 'run_test', round: 2, requestId: 'request_test' };
const base = { protocol: 'cueline/0.1', run_id: expected.runId,
  round: expected.round, request_id: expected.requestId, action: 'dispatch' };
const command = (task) => ({ ...base,
  jobs: [{ job_key: 'review', lane: 'triage', mode: 'advise', task }] });
const wrap = (body) => `<CueLineControl>${body}</CueLineControl>`;
const envelope = (value) => wrap(JSON.stringify(value));
const parse = (text) => parseControllerCommand(text, expected);

test('task strings may contain closing tags, quotes and escaped backslashes', () => {
  for (const task of ['Explain </CueLineControl> tag',
    'Explain "</CueLineControl>" tag', String.raw`one \"</CueLineControl> two \\`,
    '<CueLineControl>{"action":"wait"}</CueLineControl>']) {
    assert.equal(parse(envelope(command(task))).jobs[0].task, task);
  }
});

test('last complete envelope wins, including a trailing incomplete envelope', () => {
  const first = envelope(command('first'));
  const last = envelope(command('last </CueLineControl> tag'));
  assert.equal(parse(`${first}\n${last}\n<CueLineControl>{`).jobs[0].task,
    'last </CueLineControl> tag');
  assert.equal(parse(envelope(command('backslash \\'))).jobs[0].task, 'backslash \\');
});

test('malformed complete envelopes and missing closing tags remain rejected', () => {
  assert.throws(() => parse(envelope(command('valid')) + wrap('{oops}')),
    { code: 'CONTROL_JSON_INVALID' });
  assert.throws(() => parse('<CueLineControl>{"task":"unterminated</CueLineControl>'),
    { code: 'CONTROL_JSON_INVALID' });
  assert.throws(() => parse(wrap('{"task":"bad\\q"}')), { code: 'CONTROL_JSON_INVALID' });
  assert.throws(() => parse('<CueLineControl>{}'), { code: 'CONTROL_ENVELOPE_MISSING' });
});

test('a closed envelope with an unterminated quote must not replay the previous command', () => {
  const valid = envelope(command('valid'));
  assert.throws(() => parse(valid + '<CueLineControl>{"task":"unterminated</CueLineControl>'),
    { code: 'CONTROL_JSON_INVALID' });
  assert.equal(parse(valid + '<CueLineControl>{"task":"unterminated').jobs[0].task,
    'valid');
});

test('identity, command and envelope length validation remain enforced', () => {
  assert.throws(() => parse(envelope({ ...command('</CueLineControl>'), round: 1 })),
    { code: 'CONTROL_ID_MISMATCH' });
  assert.throws(() => parse(envelope({ ...command('</CueLineControl>'), extra: true })),
    { code: 'CONTROL_COMMAND_FIELD_UNKNOWN' });
  assert.throws(() => parse(envelope(command('x'.repeat(MAX_CONTROLLER_ENVELOPE_CHARS)))),
    { code: 'CONTROL_ENVELOPE_TOO_LARGE' });
});
