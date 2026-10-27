import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataUrl = (source) => `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`;
const errors = dataUrl(await readFile(new URL('../../src/core/errors.ts', import.meta.url), 'utf8'));
const source = await readFile(new URL('../../src/browser/claude-desktop/file-bridge.ts', import.meta.url), 'utf8');
const { createFileBridgeTools } = await import(dataUrl(source.replace('"../../core/errors.js"', JSON.stringify(errors))));

function fixture(renameError) {
  const root = join(tmpdir(), 'c48-b421-memory-only');
  const id = 'race';
  const request = `${root}/requests/${id}.json`;
  const inflight = `${root}/inflight/${id}.json`;
  const response = `${root}/responses/${id}.json`;
  const files = new Map();
  const renames = [];
  const writes = [];
  let time = 0;
  let ids = 0;
  const bridge = createFileBridgeTools({
    root, requestTimeoutMs: 10, claimedTimeoutMs: 100, pollIntervalMs: 5,
    now: () => time,
    newRequestId: () => { ids++; return id; },
    sleep: async (ms) => {
      time += ms;
      assert.ok(time <= 110, 'the fake clock must remain bounded');
      if (time === 20 && files.has(inflight)) {
        files.set(response, JSON.stringify({ id, ok: true, result: ['answer'] }));
      }
    },
    fs: {
      mkdir: async () => {},
      writeAtomic: async (path, raw) => { writes.push([path, raw]); files.set(path, raw); },
      read: async (path) => files.get(path),
      remove: async (path) => { files.delete(path); },
      rename: async (from, to) => {
        renames.push([from, to, time]);
        if (renameError) throw renameError;
        // The host wins between the bridge's read and atomic withdrawal.
        files.set(inflight, JSON.stringify({ ...JSON.parse(files.get(from)), phase: 'claimed' }));
        files.delete(from);
        throw Object.assign(new Error('host already claimed request'), { code: 'ENOENT' });
      },
    },
  });
  return { bridge, files, writes, renames, request, root, time: () => time, ids: () => ids };
}

test('ENOENT withdrawal race accepts a response after the short deadline without resending', async () => {
  const f = fixture();
  assert.deepEqual(await f.bridge.listTabs(), ['answer']);
  assert.equal(f.time(), 20);
  assert.deepEqual(f.renames, [[f.request, `${f.root}/expired/race.json`, 10]]);
  assert.equal(f.writes.length, 1);
  assert.equal(f.ids(), 1);
  assert.equal(f.files.size, 0);
});

for (const code of ['EACCES', 'EIO']) {
  test(`withdrawal preserves the original ${code} error`, async () => {
    const original = Object.assign(new Error('withdrawal failed'), { code });
    const f = fixture(original);
    await assert.rejects(f.bridge.listTabs(), (error) => error === original);
    assert.equal(f.time(), 10);
    assert.equal(f.renames.length, 1);
    assert.equal(f.writes.length, 1);
    assert.equal(f.ids(), 1);
    assert.equal(f.files.has(f.request), true);
  });
}
