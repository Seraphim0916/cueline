import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { installSkill } from '../../src/cli/skill-links.ts';

const sources = ['cueline', 'cueline-host'].map((name) =>
  fileURLToPath(new URL(`../../../skills/${name}/SKILL.md`, import.meta.url)),
);

for (const failedSource of [2, 1]) {
  test(`source ${failedSource} EACCES aborts preflight without partial installation`, { concurrency: false }, async (t) => {
    // Every filesystem operation is replaced; this home never exists on disk.
    const home = path.join(tmpdir(), 'cueline-b291-virtual-home');
    const environment = {
      HOME: home,
      CODEX_HOME: path.join(home, '.codex'),
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    };
    const failure = Object.assign(new Error('source access denied'), { code: 'EACCES' });
    const accessed = [];
    const mocks = [];
    try {
      mocks.push(t.mock.method(fs, 'access', async (candidate) => {
        accessed.push(candidate);
        if (accessed.length === failedSource) throw failure;
      }));
      mocks.push(t.mock.method(fs, 'lstat', async () => {
        throw Object.assign(new Error('target absent'), { code: 'ENOENT' });
      }));
      mocks.push(t.mock.method(fs, 'readlink', async () => {
        assert.fail('absent targets must not be read');
      }));
      const writes = Object.fromEntries(['mkdir', 'symlink', 'unlink'].map((operation) => {
        const replacement = t.mock.method(fs, operation, async () => undefined);
        mocks.push(replacement);
        return [operation, replacement];
      }));
      syncBuiltinESMExports();

      await assert.rejects(installSkill(environment, 'all'), (error) => {
        assert.strictEqual(error, failure);
        assert.equal(error.code, 'EACCES');
        return true;
      });
      assert.deepEqual(accessed, sources.slice(0, failedSource));
      for (const [operation, replacement] of Object.entries(writes)) {
        assert.equal(replacement.mock.callCount(), 0, `${operation} before preflight completes`);
      }
    } finally {
      for (const replacement of mocks) replacement.mock.restore();
      syncBuiltinESMExports();
    }
  });
}
