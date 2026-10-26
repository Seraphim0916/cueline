import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as vm from 'node:vm';

if (!vm.SourceTextModule) {
  test('takeover binding with VM modules enabled', () => {
    const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--test', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 30_000 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  });
} else {
  test('same-time requests preserve exact binding and use distinct UUID filenames', async () => {
    const home = join(tmpdir(), 'c34-b293-synthetic');
    const runId = 'run-Synthetic_293';
    const ownerId = 'Owner-Synthetic_293';
    const heartbeat = '2026-10-26T23:01:02.003+08:00';
    const requestedAt = '2026-10-27T00:04:05.006+08:00';
    const lease = join(home, runId, 'runtime-lease.json');
    const directory = `${lease}.takeover-intents`;
    const writes = [];
    const ensured = [];
    const pathCalls = [];
    const dependencies = {
      'node:crypto': { randomUUID },
      './atomic-write.js': { atomicWriteJson: async (path, record) => { writes.push({ path, record }); } },
      './private-directory.js': { ensurePrivateDirectory: async (path) => { ensured.push(path); } },
      './paths.js': { runPaths: (...args) => { pathCalls.push(args); return { runtimeLease: lease }; } },
    };
    const subject = new vm.SourceTextModule(stripTypeScriptTypes(await readFile(new URL('../../src/state/runtime-takeover-intent.ts', import.meta.url), 'utf8')));
    await subject.link((specifier) => {
      const exports = dependencies[specifier];
      assert.ok(exports, `unexpected dependency: ${specifier}`);
      return new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      });
    });
    await subject.evaluate();
    for (let i = 0; i < 2; i++) {
      await subject.namespace.persistRuntimeTakeoverIntent(home, runId, ownerId, heartbeat, requestedAt);
    }
    assert.deepEqual(pathCalls, [[home, runId], [home, runId]]);
    assert.deepEqual(ensured, [directory, directory]);
    assert.equal(writes.length, 2);
    assert.notEqual(writes[0].path, writes[1].path);
    const prefix = `${directory}/2026-10-27T00-04-05-006-08-00-`;
    for (const { path, record } of writes) {
      assert.ok(path.startsWith(prefix));
      assert.match(path.slice(prefix.length), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/);
      assert.deepEqual(JSON.parse(JSON.stringify(record)), {
        protocol: 'cueline/runtime-takeover-intent/0.1',
        run_id: runId,
        expected_owner_id: ownerId,
        expected_heartbeat_at: heartbeat,
        requested_at: requestedAt,
        operator_confirmation: true,
      });
    }
    console.log(`takeover unique paths ${writes[0].path !== writes[1].path}`);
  });
}
