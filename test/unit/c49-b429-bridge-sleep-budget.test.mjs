import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const dataUrl = (s) => `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(s))}`;
const errors = dataUrl(await readFile(new URL('../../src/core/errors.ts', import.meta.url), 'utf8'));
const source = await readFile(new URL('../../src/browser/claude-desktop/file-bridge.ts', import.meta.url), 'utf8');
const { createFileBridgeTools } = await import(dataUrl(source.replace('"../../core/errors.js"', JSON.stringify(errors))));

for (const claimed of [false, true]) {
  for (const [budget, interval, expected] of [[75, 50, [50, 25]], [25, 50, [25]], [0, 50, []]]) {
    test(`${claimed ? 'claimed' : 'unclaimed'} budget ${budget}, interval ${interval}`, async () => {
      let clock = 0;
      const sleeps = [];
      const fs = {
        async mkdir() {}, async writeAtomic() {}, async remove() {},
        async read(path) {
          if (path.includes('/requests/')) return '{}';
          if (claimed && path.includes('/inflight/')) return JSON.stringify({ id: 'test', phase: 'action_started' });
        },
      };
      const tools = createFileBridgeTools({ root: '/virtual', fs, newRequestId: () => 'test',
        requestTimeoutMs: budget, claimedTimeoutMs: budget, pollIntervalMs: interval,
        now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; } });
      await assert.rejects(tools.evaluate('tab', '1'), {
        code: claimed ? 'HOST_BRIDGE_ACTION_OUTCOME_UNKNOWN' : 'HOST_BRIDGE_TIMEOUT',
      });
      assert.deepEqual(sleeps, expected);
      assert.equal(clock, budget);
    });
  }
}

test('claim switches to its own remaining budget', async () => {
  let clock = 0;
  const sleeps = [];
  const tools = createFileBridgeTools({ root: '/virtual', newRequestId: () => 'test',
    requestTimeoutMs: 75, claimedTimeoutMs: 125, pollIntervalMs: 50,
    now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    fs: { async mkdir() {}, async writeAtomic() {}, async remove() {},
      async read(path) {
        if (path.includes('/requests/')) return '{}';
        if (path.includes('/inflight/') && clock >= 50) return JSON.stringify({ id: 'test', phase: 'claimed' });
      } } });
  await assert.rejects(tools.listTabs(), { code: 'HOST_BRIDGE_TIMEOUT' });
  assert.deepEqual(sleeps, [50, 50, 50, 25]);
  assert.equal(clock, 175);
});

test('zero polling interval remains zero', async () => {
  const sleeps = [];
  const tools = createFileBridgeTools({ root: '/virtual', newRequestId: () => 'test',
    fs: { async mkdir() {}, async writeAtomic() {}, async remove() {},
      async read(path) { return path.includes('/responses/') && sleeps.length ? JSON.stringify({ id: 'test', ok: true, result: [] }) : path.includes('/requests/') ? '{}' : undefined; } },
    now: () => 0, pollIntervalMs: 0, sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(await tools.listTabs(), []);
  assert.deepEqual(sleeps, [0]);
});
