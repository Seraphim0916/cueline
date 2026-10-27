import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
let claimNextHostMailboxRequest;
try {
  ({ claimNextHostMailboxRequest } = await import(process.env.C47_COMPILED
    ? '../../dist/src/browser/claude-desktop/host-mailbox.js'
    : '../../src/browser/claude-desktop/host-mailbox.ts'));
} finally { hooks.deregister(); }

for (const params of [[], ['value'], {}, { query: 'hello' }]) {
  test(`params ${JSON.stringify(params)} respects the object contract`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'c47-b411-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'requests'));
    const id = 'req-1-1';
    const file = `${id}.json`;
    const raw = JSON.stringify({ id, method: 'query', params, createdAt: new Date(0).toISOString() }, null, 2);
    await writeFile(join(root, 'requests', file), raw);
    if (Array.isArray(params)) {
      await assert.rejects(claimNextHostMailboxRequest(root), { code: 'HOST_MAILBOX_REQUEST_MALFORMED' });
      assert.equal(await readFile(join(root, 'rejected', file), 'utf8'), raw);
      assert.deepEqual(await readdir(join(root, 'inflight')), []);
      assert.deepEqual(await readdir(join(root, 'responses')), []);
      assert.equal(await claimNextHostMailboxRequest(root), undefined);
    } else {
      const claimed = await claimNextHostMailboxRequest(root);
      assert.equal(claimed.phase, 'action_started');
      assert.deepEqual(claimed.params, params);
      assert.deepEqual(JSON.parse(await readFile(join(root, 'inflight', file), 'utf8')), claimed);
    }
    assert.deepEqual(await readdir(join(root, 'requests')), []);
  });
}
