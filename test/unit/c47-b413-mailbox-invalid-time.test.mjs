import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const sourceRoot = new URL('../../src/', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(context.parentURL?.startsWith(sourceRoot)
      && specifier.startsWith('.') && specifier.endsWith('.js')
      ? specifier.slice(0, -3) + '.ts' : specifier, context);
  },
});
let waitForHostMailboxRequest, guardedWait, fsCalls;
try {
  ({ waitForHostMailboxRequest } = await import(process.env.C47_COMPILED
    ? '../../dist/src/browser/claude-desktop/host-mailbox.js'
    : '../../src/browser/claude-desktop/host-mailbox.ts'));
  const dataUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
  const fsUrl = dataUrl('export let calls = 0; const touch = async () => { calls++; throw new Error("FS_TOUCHED"); }; export { touch as access, touch as mkdir, touch as readdir, touch as readFile, touch as rename, touch as writeFile };');
  fsCalls = await import(fsUrl);
  const source = await readFile(new URL('../../src/browser/claude-desktop/host-mailbox.ts', import.meta.url), 'utf8');
  const guarded = stripTypeScriptTypes(source)
    .replace('"node:fs/promises"', JSON.stringify(fsUrl))
    .replace('"../../core/errors.js"', JSON.stringify(new URL('../../src/core/errors.ts', import.meta.url).href))
    .replace('"../../core/timing.js"', JSON.stringify(new URL('../../src/core/timing.ts', import.meta.url).href));
  ({ waitForHostMailboxRequest: guardedWait } = await import(dataUrl(guarded)));
} finally { hooks.deregister(); }

const maximum = 2_147_483_647;
for (const [name, code, minimum] of [
  ['waitTimeoutMs', 'HOST_MAILBOX_WAIT_TIMEOUT_INVALID', 0],
  ['pollIntervalMs', 'HOST_MAILBOX_POLL_INTERVAL_INVALID', 1],
]) {
  for (const value of [NaN, Infinity, -Infinity, -1, -0.5, 0.5, maximum + 1, Number.MAX_SAFE_INTEGER, ...(minimum ? [0] : [])]) {
    test(`${name}=${value} rejects before any filesystem operation`, async (t) => {
      const before = fsCalls.calls;
      try {
        await assert.rejects(guardedWait(join(tmpdir(), 'unused-c47-b413'), { [name]: value }), {
          code, details: { value, minimum, maximum },
        });
      } finally {
        assert.equal(fsCalls.calls, before, 'invalid timing must not access or create mailbox files');
      }
      const parent = await mkdtemp(join(tmpdir(), 'c47-b413-invalid-'));
      t.after(() => rm(parent, { recursive: true, force: true }));
      await assert.rejects(waitForHostMailboxRequest(join(parent, 'mailbox'), { [name]: value }), {
        code, details: { value, minimum, maximum },
      });
      assert.deepEqual(await readdir(parent), [], 'invalid timing must not create the mailbox');
    });
  }
}

for (const timeout of [0, 1, maximum]) {
  test(`valid timeout ${timeout} checks queued work without sleeping`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'c47-b413-ready-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'requests'));
    await writeFile(join(root, 'requests', 'req-1-1.json'), JSON.stringify({
      id: 'req-1-1', method: 'query', params: {}, createdAt: new Date(0).toISOString(),
    }));
    const claimed = await waitForHostMailboxRequest(root, {
      waitTimeoutMs: timeout, pollIntervalMs: maximum, now: () => 0,
      sleep: async () => assert.fail('queued work must not sleep'),
    });
    assert.equal(claimed.phase, 'action_started');
  });
}

test('zero timeout checks an empty mailbox once without sleeping', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'c47-b413-zero-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(waitForHostMailboxRequest(root, {
    waitTimeoutMs: 0, now: () => 0,
    sleep: async () => assert.fail('zero timeout must not sleep'),
  }), { code: 'HOST_MAILBOX_WAIT_TIMEOUT' });
  assert.deepEqual((await readdir(root)).sort(), ['inflight', 'requests', 'responses']);
});

test('default timeout and interval remain unchanged', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'c47-b413-default-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let clock = 0;
  const sleeps = [];
  await assert.rejects(waitForHostMailboxRequest(root, {
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock = 30 * 60 * 1000; },
  }), { code: 'HOST_MAILBOX_WAIT_TIMEOUT', details: { timeoutMs: 30 * 60 * 1000 } });
  assert.deepEqual(sleeps, [100]);
});
