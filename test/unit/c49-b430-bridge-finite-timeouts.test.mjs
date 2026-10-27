import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const dataUrl = (s) => `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(s))}`;
const errors = dataUrl(await readFile(new URL('../../src/core/errors.ts', import.meta.url), 'utf8'));
const source = await readFile(new URL('../../src/browser/claude-desktop/file-bridge.ts', import.meta.url), 'utf8');
const { createFileBridgeTools } = await import(dataUrl(source.replace('"../../core/errors.js"', JSON.stringify(errors))));

for (const field of ['requestTimeoutMs', 'claimedTimeoutMs']) {
  for (const value of [NaN, Infinity, -Infinity]) {
    test(`${field} rejects ${value} before any filesystem call`, async () => {
      let calls = 0;
      const fs = Object.fromEntries(['mkdir', 'writeAtomic', 'read', 'remove', 'rename'].map((name) =>
        [name, async () => { calls++; throw new Error('unexpected filesystem call'); }]));
      await assert.rejects(async () => {
        const tools = createFileBridgeTools({ root: '/virtual', fs, [field]: value });
        await tools.listTabs();
      }, { code: 'HOST_BRIDGE_TIMEOUT_INVALID' });
      assert.equal(calls, 0);
    });
  }
}

for (const value of [-1, 0, 0.5, 75]) {
  test(`finite timeout ${value} retains immediate response behaviour`, async () => {
    const tools = createFileBridgeTools({ root: '/virtual', newRequestId: () => 'test',
      requestTimeoutMs: value, claimedTimeoutMs: value, pollIntervalMs: 0,
      fs: { async mkdir() {}, async writeAtomic() {}, async remove() {},
        async read() { return JSON.stringify({ id: 'test', ok: true, result: [] }); } } });
    assert.deepEqual(await tools.listTabs(), []);
  });
}
