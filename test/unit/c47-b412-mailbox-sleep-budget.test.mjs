import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import test from 'node:test';

const sourceRoot = new URL('../../src/', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(context.parentURL?.startsWith(sourceRoot)
      && specifier.startsWith('.') && specifier.endsWith('.js')
      ? specifier.slice(0, -3) + '.ts' : specifier, context);
  },
});
let waitForHostMailboxRequest;
try {
  ({ waitForHostMailboxRequest } = await import(process.env.C47_COMPILED
    ? '../../dist/src/browser/claude-desktop/host-mailbox.js'
    : '../../src/browser/claude-desktop/host-mailbox.ts'));
} finally { hooks.deregister(); }

for (const [timeout, interval, expected] of [[75, 50, [50, 25]], [25, 100, [25]], [75, 25, [25, 25, 25]]]) {
  test(`deadline ${timeout} caps polling interval ${interval}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'c47-b412-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    let clock = 0;
    const sleeps = [];
    await assert.rejects(waitForHostMailboxRequest(root, {
      waitTimeoutMs: timeout, pollIntervalMs: interval, now: () => clock,
      sleep: async (ms) => {
        assert.ok(sleeps.length < 4, 'polling must terminate');
        sleeps.push(ms);
        clock += ms;
      },
    }), { code: 'HOST_MAILBOX_WAIT_TIMEOUT', details: { timeoutMs: timeout } });
    assert.deepEqual(sleeps, expected);
    assert.equal(clock, timeout);
  });
}

for (const stop of [false, true]) {
  test(`bounded sleep preserves ${stop ? 'stop flag' : 'new request'} handling`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'c47-b412-event-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    let clock = 0;
    const sleeps = [];
    const pending = waitForHostMailboxRequest(root, {
      waitTimeoutMs: 75, pollIntervalMs: 50, now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
        if (stop) await writeFile(join(root, 'stop.flag'), '');
        else await writeFile(join(root, 'requests', 'req-1-1.json'), JSON.stringify({
          id: 'req-1-1', method: 'query', params: {}, createdAt: new Date(0).toISOString(),
        }));
      },
    });
    if (stop) await assert.rejects(pending, { code: 'HOST_MAILBOX_STOPPED' });
    else assert.equal((await pending).phase, 'action_started');
    assert.deepEqual(sleeps, [50]);
  });
}
