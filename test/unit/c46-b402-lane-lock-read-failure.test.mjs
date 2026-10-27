import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const url = (s) => `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(s))}`;
const errors = url(await readFile(new URL('../../src/core/errors.ts', import.meta.url), 'utf8'));
const source = await readFile(new URL('../../src/browser/claude-desktop/lane-lock.ts', import.meta.url), 'utf8');
const { acquireClaudeDesktopLaneLock, setFs } = await import(url(source
  .replace(/import .* from "node:fs\/promises";/, 'let mkdir, readFile, rm, writeFile; export const setFs = (fs) => { ({ mkdir, readFile, rm, writeFile } = fs); };')
  .replace('"../../core/errors.js"', JSON.stringify(errors))));

function setup(contents, error) {
  const calls = { writes: 0, removes: 0, alive: 0 };
  setFs({
    mkdir: async () => {},
    writeFile: async () => { if (++calls.writes === 1) throw Object.assign(new Error('exists'), { code: 'EEXIST' }); },
    readFile: async () => { if (error) throw error; return contents; },
    rm: async () => { calls.removes++; },
  });
  return calls;
}
for (const code of ['EACCES', 'EIO', 'ENOENT']) {
  test(`existing lock read ${code} propagates without takeover`, async () => {
    const error = Object.assign(new Error(code), { code });
    const calls = setup('', error);
    await assert.rejects(acquireClaudeDesktopLaneLock('/virtual', { isAlive: () => { calls.alive++; return false; } }), (actual) => actual === error);
    assert.deepEqual(calls, { writes: 1, removes: 0, alive: 0 });
  });
}
test('live owner still refuses takeover', async () => {
  const calls = setup('{"pid":42}');
  await assert.rejects(acquireClaudeDesktopLaneLock('/virtual', { isAlive: (pid) => { assert.equal(pid, 42); calls.alive++; return true; } }), { code: 'CLAUDE_DESKTOP_LANE_LOCKED' });
  assert.deepEqual(calls, { writes: 1, removes: 0, alive: 1 });
});
for (const [name, contents, aliveCalls] of [['dead owner', '{"pid":42}', 1], ['corrupt JSON', '{', 0]]) {
  test(`${name} still permits takeover`, async () => {
    const calls = setup(contents);
    const lock = await acquireClaudeDesktopLaneLock('/virtual', { isAlive: () => { calls.alive++; return false; } });
    assert.equal(typeof lock.release, 'function');
    assert.deepEqual(calls, { writes: 2, removes: 1, alive: aliveCalls });
  });
}
