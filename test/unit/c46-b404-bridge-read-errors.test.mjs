import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = await readFile(new URL('../../src/browser/claude-desktop/node-file-bridge-fs.ts', import.meta.url), 'utf8');
const { createNodeFileBridgeFs, setFs } = await import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source
  .replace(/import .* from "node:fs\/promises";/, 'let mkdir, readFile, rename, rm, writeFile; export const setFs = (fs) => { ({ mkdir, readFile, rename, rm, writeFile } = fs); };')))}`);

for (const code of [undefined, 'ENOENT', 'EACCES', 'EIO', 'ENOTDIR']) {
  test(`read ${code ?? 'normal text'} performs only one read`, async () => {
    const calls = [];
    const error = Object.assign(new Error(code), { code });
    const fs = Object.fromEntries(['mkdir', 'rename', 'rm', 'writeFile'].map((name) => [name, async (...args) => { calls.push([name, ...args]); }]));
    fs.readFile = async (...args) => { calls.push(['readFile', ...args]); if (code) throw error; return '繁體文字\n'; };
    setFs(fs);
    const reading = createNodeFileBridgeFs().read('/mailbox');
    if (!code || code === 'ENOENT') assert.equal(await reading, code ? undefined : '繁體文字\n');
    else await assert.rejects(reading, (actual) => actual === error);
    assert.deepEqual(calls, [['readFile', '/mailbox', 'utf8']]);
  });
}
