import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runPaths } from '../../dist/src/state/paths.js';

const home = path.join(tmpdir(), 'c9-b67-home');

test('accepts the full ASCII alphabet and the 128-character boundary', () => {
  const initials = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const suffixes = `${initials}._-`;
  const ids = [...initials, ...[...suffixes].map(char => `a${char}`),
    'a'.repeat(127), 'Z'.repeat(128), `0${'._-'.repeat(42)}x`, 'abc'];
  for (const id of ids) {
    const paths = runPaths(home, id);
    assert.equal(paths.home, path.resolve(home));
    assert.equal(paths.runsDir, path.join(home, 'runs'));
    assert.equal(paths.runDir, path.join(home, 'runs', id));
    const { home: ignoredHome, runsDir, runDir, ...artifacts } = paths;
    assert.deepEqual(Object.keys(artifacts).sort(), [
      'creationMarker', 'events', 'runtimeLease', 'runCancellation',
      'jobCancellationsDir', 'snapshot',
    ].sort());
    for (const [field, target] of Object.entries(artifacts)) {
      const relative = path.relative(runDir, target);
      assert.ok(relative.length > 0, `${id}: ${field} is a child`);
      assert.equal(path.isAbsolute(relative), false, `${id}: ${field}`);
      assert.notEqual(relative.split(path.sep)[0], '..', `${id}: ${field}`);
    }
  }
});

test('rejects length overflow, invalid starts, separators and traversal', () => {
  for (const id of ['', 'a'.repeat(129), '.abc', '_abc', '-abc', ' abc',
    '.', '..', '../escape', 'abc/def', '/abc', 'abc/',
    'abc\\def', '\\abc', 'abc\\', 'éabc', '中abc']) {
    assert.throws(() => runPaths(home, id), /RUN_ID_INVALID/, JSON.stringify(id));
  }
});

test('rejects control and Unicode separators at every position, including trailing line breaks', () => {
  const forbidden = [...Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)),
    '\x7f', '\x85', '\u00a0', '\u1680', '\u2000', '\u2007', '\u200b',
    '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff', '\u2215', '\uff0f'];
  for (const char of forbidden) {
    for (const id of [`${char}abc`, `a${char}bc`, `abc${char}`]) {
      assert.throws(() => runPaths(home, id), /RUN_ID_INVALID/, JSON.stringify(id));
    }
  }
});
