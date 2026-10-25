import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { setTimeout as realSetTimeout, clearTimeout as realClearTimeout } from 'node:timers';

const dataUrl = (source) => `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`;
let source = await readFile(new URL('../../src/browser/codex-iab/submission-url.ts', import.meta.url), 'utf8');
for (const name of ['errors', 'conversation-url']) {
  const dependency = await readFile(new URL(`../../src/core/${name}.ts`, import.meta.url), 'utf8');
  source = source.replace(`"../../core/${name}.js"`, JSON.stringify(dataUrl(dependency)));
}
const { captureConversationUrlAfterSubmit: capture } = await import(dataUrl(source));
const url = 'https://chatgpt.com/c/expected';
const unavailable = { code: 'CONTROLLER_CONVERSATION_URL_UNAVAILABLE' };
const never = () => new Promise(() => {});
const later = (ms, value) => new Promise(resolve => realSetTimeout(resolve, ms, value));

// Track only production timers; the outer deadline uses unmodified node timers.
async function observed(t, run) {
  const active = new Set();
  const durations = [];
  const controller = new AbortController();
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    durations.push(ms);
    const timer = realSetTimeout(() => { active.delete(timer); fn(...args); }, ms);
    active.add(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => {
    active.delete(timer);
    realClearTimeout(timer);
  });
  let guard;
  try {
    await Promise.race([
      run(controller, durations),
      new Promise((_, reject) => { guard = realSetTimeout(() => reject(new Error('outer deadline exceeded')), 500); }),
    ]);
    assert.equal(active.size, 0, 'production timers must be cleared');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'abort listeners must be removed');
  } finally {
    realClearTimeout(guard);
    for (const timer of active) realClearTimeout(timer);
    t.mock.restoreAll();
  }
}

for (const timeout of [0, 20]) {
  test(`never completing url respects ${timeout}ms deadline`, t => observed(t, async c => {
    await assert.rejects(capture({ url: never }, undefined, timeout, 100, c.signal), unavailable);
  }));
}
test('delayed success before deadline', t => observed(t, async c => {
  assert.equal(await capture({ url: () => later(5, url) }, undefined, 200, 5, c.signal), url);
}));
test('success arriving after deadline is not accepted', t => observed(t, async c => {
  await assert.rejects(capture({ url: () => later(80, url) }, undefined, 10, 5, c.signal), unavailable);
}));
test('a late read rejection remains handled after timeout', t => observed(t, async c => {
  await assert.rejects(capture({ url: () => new Promise((_, reject) => {
    realSetTimeout(() => reject(new Error('late read failure')), 25);
  }) }, undefined, 5, 5, c.signal), unavailable);
  await later(35);
}));
test('rejected reads preserve unavailable error', t => observed(t, async c => {
  await assert.rejects(capture({ url: async () => { throw new Error('read failed'); } }, undefined, 15, 5, c.signal), unavailable);
}));
test('rejected read can recover on the next poll', t => observed(t, async c => {
  let calls = 0;
  assert.equal(await capture({ url: async () => {
    if (++calls === 1) throw new Error('transient');
    return url;
  } }, undefined, 200, 5, c.signal), url);
}));
test('abort interrupts a pending read and preserves reason', t => observed(t, async c => {
  const reason = new Error('cancel capture');
  const pending = capture({ url: never }, undefined, 200, 5, c.signal);
  queueMicrotask(() => c.abort(reason));
  await assert.rejects(pending, error => error === reason);
}));
test('already aborted does not read the tab', t => observed(t, async c => {
  const reason = new Error('already cancelled');
  c.abort(reason);
  let reads = 0;
  await assert.rejects(capture({ url: async () => { reads++; return url; } }, undefined, 200, 5, c.signal), error => error === reason);
  assert.equal(reads, 0);
}));
test('abort during polling cleans up resources', t => observed(t, async c => {
  const reason = new Error('cancel poll');
  const abortTimer = realSetTimeout(() => c.abort(reason), 10);
  try {
    await assert.rejects(capture({ url: async () => '' }, undefined, 200, 100, c.signal), error => error === reason);
  } finally { realClearTimeout(abortTimer); }
}));
test('conversation mismatch keeps existing error', t => observed(t, async c => {
  await assert.rejects(capture({ url: async () => 'https://chatgpt.com/c/other' }, url, 200, 5, c.signal),
    { code: 'CONTROLLER_RECONCILIATION_CONVERSATION_MISMATCH' });
}));
test('capture budget is capped at fifteen seconds', t => observed(t, async (c, durations) => {
  const pending = capture({ url: never }, undefined, 60_000, 5, c.signal);
  queueMicrotask(() => c.abort(new Error('stop cap check')));
  await assert.rejects(pending, /stop cap check/);
  assert.ok(durations.some(ms => ms > 14_000 && ms <= 15_000));
  assert.ok(durations.every(ms => ms <= 15_000));
}));
