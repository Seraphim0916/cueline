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

const id = 'phase-retention';
const badClaims = [
  ['malformed JSON', '{broken'],
  ['different id', JSON.stringify({ id: 'other', phase: 'action_completed' })],
  ['unknown phase', JSON.stringify({ id, phase: 'unrecognized' })],
];

for (const [label, badClaim] of badClaims) {
  for (const knownFirst of [true, false]) {
    test(`${label}: ${knownFirst ? 'retain action_started' : 'initial bad claim has no known phase'}`, async () => {
      const root = join(tmpdir(), 'c48-b422-memory-only');
      const request = `${root}/requests/${id}.json`;
      const inflight = `${root}/inflight/${id}.json`;
      const files = new Map();
      const removed = [];
      const renamed = [];
      let time = 0;
      let claimReads = 0;
      let writes = 0;
      const bridge = createFileBridgeTools({
        root, requestTimeoutMs: 10, claimedTimeoutMs: 30, pollIntervalMs: 5,
        newRequestId: () => id,
        now: () => time,
        sleep: async (ms) => {
          time += ms;
          assert.ok(time <= 30, 'bad claim reads must not restart the claimed deadline');
          files.set(inflight, badClaim);
        },
        fs: {
          mkdir: async () => {},
          writeAtomic: async (path, raw) => {
            writes++;
            files.set(path, raw);
            files.set(inflight, knownFirst ? JSON.stringify({ id, phase: 'action_started' }) : badClaim);
            files.delete(request); // Simulate a host's atomic claim, without a real mailbox.
          },
          read: async (path) => {
            if (path === inflight) claimReads++;
            return files.get(path);
          },
          remove: async (path) => { removed.push(path); files.delete(path); },
          rename: async (...args) => { renamed.push(args); },
        },
      });
      await assert.rejects(bridge.navigate('tab', 'https://example.test/'), (error) => {
        assert.equal(error.code, 'HOST_BRIDGE_ACTION_OUTCOME_UNKNOWN');
        assert.equal(error.details.id, id);
        assert.equal(error.details.method, 'navigate');
        assert.equal(error.details.claimed, true);
        assert.equal(error.details.timeoutMs, 30);
        if (knownFirst) assert.equal(error.details.phase, 'action_started');
        else assert.equal(Object.hasOwn(error.details, 'phase'), false);
        return true;
      });
      assert.equal(time, 30);
      assert.equal(claimReads, 7);
      assert.equal(writes, 1);
      assert.deepEqual(removed, []);
      assert.deepEqual(renamed, []);
      assert.equal(files.get(inflight), badClaim);
      assert.equal(files.size, 1);
    });
  }
}
