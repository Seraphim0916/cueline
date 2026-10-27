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

function fixture(id) {
  const calls = { mkdir: [], writeAtomic: [], read: [], remove: [], rename: [] };
  const root = join(tmpdir(), 'c48-b420-memory-only');
  const fs = Object.fromEntries(Object.keys(calls).map((method) => [method, async (...args) => {
    calls[method].push(args);
    if (method === 'read') return JSON.stringify({ id, ok: true, result: [] });
  }]));
  return { calls, root, bridge: createFileBridgeTools({ root, fs, newRequestId: () => id }) };
}

const invalid = [
  '', 'a'.repeat(65), '_safe', '-safe', '.safe', '/safe',
  'safe/path', 'safe\\path', 'safe.name', 'safe space', 'safe:part',
  'safe\npart', 'safe\rpart', 'safe\u2028part', 'safe\u2029part',
  'safe\n', 'safe\r', 'safe\r\n', 'safe\u2028', 'safe\u2029',
];
for (const id of invalid) {
  test(`invalid id ${JSON.stringify(id)} is rejected before every filesystem operation`, async () => {
    const { bridge, calls } = fixture(id);
    try {
      await assert.rejects(bridge.listTabs(), { code: 'HOST_BRIDGE_REQUEST_ID_INVALID' });
    } finally {
      assert.deepEqual(Object.fromEntries(Object.entries(calls).map(([name, entries]) => [name, entries.length])),
        { mkdir: 0, writeAtomic: 0, read: 0, remove: 0, rename: 0 });
    }
  });
}

for (const id of ['safe', 'a', 'Z', '0', 'a'.repeat(64), 'A_z-09', '0_-']) {
  test(`valid id ${JSON.stringify(id)} remains unchanged`, async () => {
    const { bridge, calls, root } = fixture(id);
    assert.deepEqual(await bridge.listTabs(), []);
    assert.equal(calls.writeAtomic.length, 1);
    const [path, contents] = calls.writeAtomic[0];
    assert.equal(path, `${root}/requests/${id}.json`);
    assert.equal(JSON.parse(contents).id, id);
    assert.deepEqual(calls.read, [[`${root}/responses/${id}.json`]]);
    assert.deepEqual(calls.remove, [
      [`${root}/responses/${id}.json`], [`${root}/requests/${id}.json`], [`${root}/inflight/${id}.json`],
    ]);
    assert.equal(calls.rename.length, 0);
  });
}
